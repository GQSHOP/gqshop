/**
 * 市场站路由（ADR-012 α）：
 *   /api/auth/*   注册/登录/me（auth.ts）
 *   /api/dev/*    developer 提交（multipart zip + auto_scan）与我的提交
 *   /api/admin/*  审核队列/批准=签包发布/拒绝 + developer 开通审批
 * SQL 一律字面量模板 + $n 参数化（对齐全仓风格）。
 */
import { Hono } from "hono";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Pool } from "pg";

import type { LicenseEnv } from "./auth.ts";
import { authRoutes, sessionMiddleware } from "./auth.ts";
import { autoScan, NAME_RE, VERSION_RE } from "./scan.ts";
import { publishPackage } from "./publish.ts";
import { epayConfigFromEnv, epaySubmitUrl, epayVerify, genOrderNo, settleOrder, svipPriceCents, yuan, EPAY_TRADE_SUCCESS, issueLicense } from "./pay.ts";
import { unpublishPlugin } from "./publish.ts";

export function createApp(pool: Pool): Hono<LicenseEnv> {
  const app = new Hono<LicenseEnv>();

  app.use("*", async (c, next) => {
    c.set("pool", pool);
    await next();
  });

  app.get("/api/healthz", async (c) => c.json({ status: "ok", ts: Date.now() }));

  // ---------- 公开：上架清单（含定价，console 购买列表用） ----------
  app.get("/api/plugins", async (c) => {
    const r = await pool.query(
      `SELECT p.name, p.price_model, p.price_cents, a.display_name AS developer
       FROM market_plugin p JOIN market_account a ON a.id = p.developer_id
       WHERE EXISTS (SELECT 1 FROM market_submission s WHERE s.plugin_name = p.name AND s.status = 'published')
       ORDER BY p.name ASC LIMIT 200`,
    );
    const idx = await (await import("./publish.ts")).readMarketIndex();
    const latest = new Map<string, { version: string; description: string }>();
    for (const e of [...idx].sort((a, b) => b.date.localeCompare(a.date))) {
      if (!latest.has(e.name)) latest.set(e.name, { version: e.version, description: e.description });
    }
    return c.json({
      code: 0,
      data: r.rows.map((p: { name: string; price_model: string; price_cents: number; developer: string }) => ({
        ...p,
        ...(latest.get(p.name) ?? { version: "-", description: "" }),
      })),
    });
  });

  // ---------- 公开：epay 回调（MD5 验签 → 金额核对 → settle + 签发 license；幂等） ----------
  app.get("/api/pay/notify/epay", async (c) => {
    const cfg = epayConfigFromEnv();
    if (!cfg) return c.text("pay not configured", 503);
    const q = c.req.query() as Record<string, string>;
    if (!epayVerify(q, cfg.key)) return c.text("sign error", 403);
    if (q.trade_status !== EPAY_TRADE_SUCCESS) return c.text("success"); // 非成功态不结算但确认收到
    const no = String(q.out_trade_no ?? "").slice(0, 64);
    // 金额核对：notify 金额须与订单一致（双保险——签名外再挡金额错配/半付）
    const amt = await pool.query<{ amount_cents: number }>(
      `SELECT amount_cents FROM market_pay_order WHERE out_trade_no = $1 LIMIT 1`,
      [no],
    );
    const expect = yuan(amt.rows[0]?.amount_cents ?? -1);
    if (!amt.rows[0] || String(q.money ?? "") !== expect) {
      console.error(`[license] notify 金额不符 ${no}: notify=${q.money} expect=${expect}`);
      return c.text("amount mismatch", 409);
    }
    const r = await settleOrder(pool, no, String(q.trade_no ?? "").slice(0, 64));
    console.log(`[license] notify settle ${no}: ${r.msg}`);
    return r.ok ? c.text("success") : c.text(r.msg, 409);
  });

  app.route("/", authRoutes);

  // ---------- developer 面 ----------
  // apply 挂在角色门之前（customer 才需要申请；门内路由要求 developer/admin）
  app.post("/api/dev/apply", sessionMiddleware, async (c) => {
    if (c.get("accountRole") !== "customer") return c.json({ code: 409, msg: "已是 developer/admin" }, 409);
    const body = (await c.req.json().catch(() => null)) as { intro?: string } | null;
    const intro = String(body?.intro ?? "").slice(0, 1000);
    if (intro.length < 20) return c.json({ code: 400, msg: "简介至少 20 字（作品/技术背景）" }, 400);
    await c.get("pool").query(
      `UPDATE market_account SET dev_profile = $1, dev_pending = TRUE WHERE id = $2`,
      [intro, c.get("accountId")],
    );
    return c.json({ code: 0, msg: "申请已提交，等待平台审批" });
  });

  const dev = new Hono<LicenseEnv>();
  // 作用域限定：子应用挂在根路径，use("*") 会波及后注册的路由（曾拦住 /api/purchase）
  dev.use("/api/dev/*", sessionMiddleware);
  dev.use("/api/dev/*", async (c, next) => {
    if (c.get("accountRole") === "customer") return c.json({ code: 403, msg: "请先申请开发者权限" }, 403);
    await next();
  });

  dev.get("/api/dev/submissions", async (c) => {
    const r = await c.get("pool").query(
      `SELECT id, plugin_name, version, description, status, review_notes, scan_report, created_at, reviewed_at
       FROM market_submission WHERE developer_id = $1 ORDER BY id DESC LIMIT 50`,
      [c.get("accountId")],
    );
    return c.json({ code: 0, data: r.rows });
  });

  /** γ：我的收益（分成明细+汇总）。 */
  dev.get("/api/dev/earnings", async (c) => {
    const pool2 = c.get("pool");
    const rows = await pool2.query(
      `SELECT s.order_no, s.plugin_name, s.gross_cents, s.platform_fee_cents, s.dev_net_cents, s.created_at,
              o.licensee, o.paid_time
       FROM market_sales_record s JOIN market_pay_order o ON o.out_trade_no = s.order_no
       WHERE s.developer_id = $1 ORDER BY s.id DESC LIMIT 200`,
      [c.get("accountId")],
    );
    const agg = await pool2.query<{ cnt: string; gross: string; net: string }>(
      `SELECT COUNT(*) AS cnt, COALESCE(SUM(gross_cents),0) AS gross, COALESCE(SUM(dev_net_cents),0) AS net
       FROM market_sales_record WHERE developer_id = $1`,
      [c.get("accountId")],
    );
    const a = agg.rows[0];
    return c.json({ code: 0, data: { total: { orders: Number(a.cnt), gross_cents: Number(a.gross), dev_net_cents: Number(a.net) }, rows: rows.rows } });
  });

  /** 提交新版本：multipart（zip + plugin_name + version + description）→ auto_scan → in_review/rejected。 */
  dev.post("/api/dev/submit", async (c) => {
    const body = await c.req.parseBody().catch(() => null);
    const file = body?.["zip"];
    const name = String(body?.["plugin_name"] ?? "");
    const version = String(body?.["version"] ?? "");
    const description = String(body?.["description"] ?? "").slice(0, 500);
    if (!file || typeof file === "string") return c.json({ code: 400, msg: "zip 文件 required" }, 400);
    if (!NAME_RE.test(name)) return c.json({ code: 400, msg: "插件名须 ^[a-z][a-z0-9_]{2,49}$" }, 400);
    if (!VERSION_RE.test(version)) return c.json({ code: 400, msg: "版本号须 semver 三段式（如 1.0.0）" }, 400);
    const buf = Buffer.from(await file.arrayBuffer());
    if (buf.length === 0 || buf.length > 2 * 1024 * 1024) return c.json({ code: 400, msg: "zip 须 1B-2MB" }, 400);

    const pool = c.get("pool");
    const aid = c.get("accountId");
    // β：定价（新插件首次提交时设定；已占用插件定价仅 admin 可改）
    const priceModel = ["free", "onetime"].includes(String(body?.["price_model"] ?? "")) ? String(body?.["price_model"]) : "free";
    const priceCents = Math.max(0, Math.min(1_000_000, Math.floor(Number(body?.["price_cents"] ?? 0) || 0)));
    if (priceModel === "onetime" && priceCents < 1) return c.json({ code: 400, msg: "onetime 须定价（分）" }, 400);
    if (priceModel === "free" && priceCents !== 0) return c.json({ code: 400, msg: "free 插件价格须为 0" }, 400);
    // 名字占用：先到先得（提交即占，防抢注）
    const owner = await pool.query<{ developer_id: string }>(
      `SELECT developer_id FROM market_plugin WHERE name = $1 LIMIT 1`,
      [name],
    );
    if (owner.rows[0] && Number(owner.rows[0].developer_id) !== aid) {
      return c.json({ code: 409, msg: "插件名已被占用" }, 409);
    }
    if (!owner.rows[0]) {
      await pool.query(
        `INSERT INTO market_plugin (name, developer_id, price_model, price_cents, created_at) VALUES ($1, $2, $3, $4, $5)`,
        [name, aid, priceModel, priceCents, Date.now()],
      );
    }
    // 版本冲突：published 不可覆盖；in_review 占位中；自己的历史 rejected 可重提（替换）
    const prior = await pool.query<{ id: string; status: string; zip_path: string }>(
      `SELECT id, status, zip_path FROM market_submission WHERE plugin_name = $1 AND version = $2 LIMIT 1`,
      [name, version],
    );
    const prev = prior.rows[0];
    if (prev && prev.status !== "rejected") {
      return c.json({ code: 409, msg: `该版本已${prev.status === "published" ? "发布（不可覆盖）" : "在审"}` }, 409);
    }

    const report = await autoScan(buf, name, version);
    const now = Date.now();
    // 包体落提交库：随机十六进制文件名（服务端生成，非用户可控）
    const subDir = resolve(process.env.GQSHOP_SUBMISSIONS_DIR ?? "./data/submissions");
    mkdirSync(subDir, { recursive: true });
    const stored = `${randomBytes(16).toString("hex")}.zip`;
    writeFileSync(join(subDir, stored), buf);

    const manifestDesc = report.manifest?.description ?? "";
    if (prev) {
      await pool.query(`DELETE FROM market_submission WHERE id = $1`, [Number(prev.id)]);
    }
    const ins = await pool.query<{ id: string }>(
      `INSERT INTO market_submission
         (plugin_name, version, developer_id, description, zip_path, zip_sha256, manifest_json, scan_report, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [
        name, version, aid, description || manifestDesc, stored,
        // 提交侧校验和：审核发布时比对（防审核期间文件被替换）
        createHash("sha256").update(buf).digest("hex"),
        JSON.stringify(report.manifest), JSON.stringify(report),
        report.pass ? "in_review" : "rejected", now,
      ],
    );
    return c.json(
      report.pass
        ? { code: 0, msg: "已提交，等待人工审核", data: { id: Number(ins.rows[0].id), scan: report } }
        : { code: 422, msg: `自动检查未过：${report.reason}`, data: { id: Number(ins.rows[0].id), scan: report } },
      report.pass ? 201 : 422,
    );
  });
  app.route("/", dev);

  // ---------- buyer 面（β：任意登录角色可购） ----------
  const buyer = new Hono<LicenseEnv>();
  buyer.use("/api/purchase/*", sessionMiddleware);
  buyer.use("/api/my/*", sessionMiddleware);

  const HOST_RE = /^[a-z0-9]([a-z0-9.-]{1,251}[a-z0-9])?$/;
  async function activeLicense(pool2: Pool, plugin: string | null, licensee: string): Promise<boolean> {
    if (plugin !== null) {
      const r = await pool2.query(
        `SELECT 1 FROM market_license WHERE license_type = 'plugin' AND plugin_name = $1 AND licensee = $2 AND state = 0 LIMIT 1`,
        [plugin, licensee],
      );
      if (r.rowCount) return true;
    }
    const sv = await pool2.query(
      `SELECT 1 FROM market_license WHERE license_type = 'svip' AND licensee = $1 AND state = 0
        AND (expires_at IS NULL OR expires_at > $2) LIMIT 1`,
      [licensee, Math.floor(Date.now() / 1000)],
    );
    return sv.rowCount !== null && sv.rowCount > 0;
  }

  buyer.post("/api/purchase", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { plugin_name?: string; domain?: string } | null;
    const name = String(body?.plugin_name ?? "");
    const domain = String(body?.domain ?? "").trim().toLowerCase();
    if (!NAME_RE.test(name)) return c.json({ code: 400, msg: "plugin_name 不合法" }, 400);
    if (!HOST_RE.test(domain) || !domain.includes(".")) return c.json({ code: 400, msg: "domain 须为你的店铺域名（如 demo.sc9.top）" }, 400);
    const pool2 = c.get("pool");
    const p = await pool2.query<{ developer_id: string; price_model: string; price_cents: number }>(
      `SELECT developer_id, price_model, price_cents FROM market_plugin WHERE name = $1 LIMIT 1`,
      [name],
    );
    const plugin = p.rows[0];
    if (!plugin) return c.json({ code: 404, msg: "插件不存在" }, 404);
    if (plugin.price_model === "free") return c.json({ code: 400, msg: "免费插件无需购买（直接安装）" }, 400);
    if (Number(plugin.developer_id) === c.get("accountId")) return c.json({ code: 409, msg: "不能购买自己的插件" }, 409);
    if (await activeLicense(pool2, name, domain)) return c.json({ code: 409, msg: "该域名已持有此插件的有效授权（或有效 SVIP）" }, 409);
    const cfg = epayConfigFromEnv();
    if (!cfg) return c.json({ code: 503, msg: "支付通道未配置" }, 503);
    const no = genOrderNo();
    await pool2.query(
      `INSERT INTO market_pay_order (out_trade_no, account_id, sku_type, plugin_name, licensee, amount_cents, status, gateway, create_time)
       VALUES ($1, $2, 'plugin', $3, $4, $5, 0, 'epay', $6)`,
      [no, c.get("accountId"), name, domain, plugin.price_cents, Date.now()],
    );
    const payUrl = await epaySubmitUrl(cfg, { outTradeNo: no, name: `GQSHOP市场-${name} 授权`, amountCents: plugin.price_cents });
    return c.json({ code: 0, data: { out_trade_no: no, amount_cents: plugin.price_cents, pay_url: payUrl } }, 201);
  });

  buyer.post("/api/purchase/svip", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { domain?: string } | null;
    const domain = String(body?.domain ?? "").trim().toLowerCase();
    if (!HOST_RE.test(domain) || !domain.includes(".")) return c.json({ code: 400, msg: "domain 须为你的店铺域名" }, 400);
    const pool2 = c.get("pool");
    const sv = await pool2.query(
      `SELECT 1 FROM market_license WHERE license_type = 'svip' AND licensee = $1 AND state = 0 AND expires_at > $2 LIMIT 1`,
      [domain, Math.floor(Date.now() / 1000)],
    );
    if (sv.rowCount) return c.json({ code: 409, msg: "该域名已有生效中的 SVIP" }, 409);
    const cfg = epayConfigFromEnv();
    if (!cfg) return c.json({ code: 503, msg: "支付通道未配置" }, 503);
    const no = genOrderNo();
    await pool2.query(
      `INSERT INTO market_pay_order (out_trade_no, account_id, sku_type, plugin_name, licensee, amount_cents, status, gateway, create_time)
       VALUES ($1, $2, 'svip', NULL, $3, $4, 0, 'epay', $5)`,
      [no, c.get("accountId"), domain, svipPriceCents(), Date.now()],
    );
    const payUrl = await epaySubmitUrl(cfg, { outTradeNo: no, name: `GQSHOP市场-SVIP 月度（${domain}）`, amountCents: svipPriceCents() });
    return c.json({ code: 0, data: { out_trade_no: no, amount_cents: svipPriceCents(), pay_url: payUrl } }, 201);
  });

  buyer.get("/api/my/licenses", async (c) => {
    const r = await c.get("pool").query(
      `SELECT id, license_type, plugin_name, licensee, issued_at, expires_at, state
       FROM market_license WHERE account_id = $1 ORDER BY id DESC LIMIT 100`,
      [c.get("accountId")],
    );
    return c.json({ code: 0, data: r.rows });
  });

  buyer.get("/api/my/licenses/:id/download", async (c) => {
    const id = Number(c.req.param("id") ?? 0);
    const r = await c.get("pool").query<{ id: string; plugin_name: string | null; account_id: string; payload: string; sig: string }>(
      `SELECT id, plugin_name, account_id, payload, sig FROM market_license WHERE id = $1 AND state = 0 LIMIT 1`,
      [id],
    );
    const lic = r.rows[0];
    if (!lic || Number(lic.account_id) !== c.get("accountId")) return c.json({ code: 404, msg: "license 不存在" }, 404);
    const file = JSON.stringify({ payload: JSON.parse(lic.payload), sig: lic.sig });
    const fname = lic.plugin_name ? `${lic.plugin_name}.lic` : `svip-${lic.id}.lic`;
    return new Response(file, {
      headers: { "content-type": "application/octet-stream", "content-disposition": `attachment; filename="${fname}"` },
    });
  });
  app.route("/", buyer);

  // ---------- admin 面 ----------
  const adm = new Hono<LicenseEnv>();
  adm.use("/api/admin/*", sessionMiddleware);
  adm.use("/api/admin/*", async (c, next) => {
    if (c.get("accountRole") !== "admin") return c.json({ code: 403, msg: "admin only" }, 403);
    await next();
  });

  adm.get("/api/admin/queue", async (c) => {
    const status = ["in_review", "published", "rejected"].includes(String(c.req.query("status") ?? ""))
      ? String(c.req.query("status"))
      : "in_review";
    const r = await c.get("pool").query(
      `SELECT s.id, s.plugin_name, s.version, s.description, s.status, s.scan_report, s.review_notes,
              s.created_at, s.reviewed_at, a.email AS developer, a.display_name
       FROM market_submission s JOIN market_account a ON a.id = s.developer_id
       WHERE s.status = $1 ORDER BY s.created_at ASC LIMIT 100`,
      [status],
    );
    return c.json({ code: 0, data: r.rows });
  });

  /** 审核：approve=签包+落盘+index 再生；reject=附理由退回。 */
  adm.post("/api/admin/review", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { id?: number; action?: string; notes?: string } | null;
    const id = Number(body?.id ?? 0);
    const action = body?.action === "approve" ? "approve" : body?.action === "reject" ? "reject" : "";
    const notes = String(body?.notes ?? "").slice(0, 1000);
    if (!id || !action) return c.json({ code: 400, msg: "id/action(approve|reject) required" }, 400);
    const pool = c.get("pool");
    const r = await pool.query<{ id: string; plugin_name: string; version: string; description: string; zip_path: string; zip_sha256: string; status: string; manifest_json: string | null }>(
      `SELECT id, plugin_name, version, description, zip_path, zip_sha256, status, manifest_json
       FROM market_submission WHERE id = $1 LIMIT 1`,
      [id],
    );
    const s = r.rows[0];
    if (!s) return c.json({ code: 404, msg: "submission 不存在" }, 404);
    if (s.status !== "in_review") return c.json({ code: 409, msg: `状态 ${s.status} 不可审` }, 409);

    if (action === "reject") {
      if (notes.length < 5) return c.json({ code: 400, msg: "拒绝须附理由（≥5 字）" }, 400);
      await pool.query(
        `UPDATE market_submission SET status = 'rejected', review_notes = $1, reviewer_id = $2, reviewed_at = $3 WHERE id = $4`,
        [notes, c.get("accountId"), Date.now(), id],
      );
      return c.json({ code: 0, msg: "已拒绝" });
    }

    // approve：读包体 → sha256 比对（防审核后文件被换）→ 签包发布
    const subDir = resolve(process.env.GQSHOP_SUBMISSIONS_DIR ?? "./data/submissions");
    let buf: Buffer;
    try {
      buf = readFileSync(join(subDir, s.zip_path));
    } catch {
      return c.json({ code: 410, msg: "提交包文件缺失" }, 410);
    }
    const sha = createHash("sha256").update(buf).digest("hex");
    if (sha !== s.zip_sha256) return c.json({ code: 409, msg: "包体与提交时不一致，拒绝发布" }, 409);
    let manifestDesc = s.description;
    try {
      const m = JSON.parse(s.manifest_json ?? "{}") as { description?: string };
      if (m.description) manifestDesc = String(m.description).slice(0, 500);
    } catch { /* 用提交描述 */ }
    try {
      // β：paid 标记随发布进 index（kernel 安装期据此要求 license）
      const pr = await pool.query<{ price_model: string }>(
        `SELECT price_model FROM market_plugin WHERE name = $1 LIMIT 1`,
        [s.plugin_name],
      );
      const paid = (pr.rows[0]?.price_model ?? "free") !== "free";
      await publishPackage(buf, s.plugin_name, s.version, manifestDesc, paid);
    } catch (err) {
      return c.json({ code: 500, msg: `发布失败: ${String((err as Error).message).slice(0, 200)}` }, 500);
    }
    await pool.query(
      `UPDATE market_submission SET status = 'published', review_notes = $1, reviewer_id = $2, reviewed_at = $3 WHERE id = $4`,
      [notes, c.get("accountId"), Date.now(), id],
    );
    return c.json({ code: 0, msg: `已发布 ${s.plugin_name}@${s.version}` });
  });

  adm.get("/api/admin/developers", async (c) => {
    const r = await c.get("pool").query(
      `SELECT id, email, display_name, dev_profile, created_at FROM market_account
       WHERE dev_pending = TRUE AND role = 'customer' ORDER BY id ASC LIMIT 50`,
    );
    return c.json({ code: 0, data: r.rows });
  });

  /** β：改价（price_model/price_cents；发布时据此写 paid 标记，改后下一版本生效）。 */
  adm.post("/api/admin/price", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { name?: string; price_model?: string; price_cents?: number } | null;
    const name = String(body?.name ?? "");
    const model = ["free", "onetime"].includes(String(body?.price_model ?? "")) ? String(body?.price_model) : "";
    const cents = Math.floor(Number(body?.price_cents ?? NaN));
    if (!NAME_RE.test(name) || !model || !Number.isFinite(cents) || cents < 0 || cents > 1_000_000) {
      return c.json({ code: 400, msg: "name/price_model/price_cents 不合法" }, 400);
    }
    if (model === "onetime" && cents < 1) return c.json({ code: 400, msg: "onetime 须定价" }, 400);
    if (model === "free" && cents !== 0) return c.json({ code: 400, msg: "free 价格须为 0" }, 400);
    const r = await c.get("pool").query(
      `UPDATE market_plugin SET price_model = $1, price_cents = $2 WHERE name = $3 RETURNING name`,
      [model, cents, name],
    );
    if (!r.rowCount) return c.json({ code: 404, msg: "插件不存在" }, 404);
    return c.json({ code: 0, msg: `已改价 ${name} → ${model}${model === "onetime" ? ` ¥${(cents / 100).toFixed(2)}` : ""}（下一版本发布时生效 paid 标记）` });
  });

  // ---------- γ：运营台（销售报表/结算导出/license 管理/下架） ----------

  adm.get("/api/admin/sales/summary", async (c) => {
    const pool2 = c.get("pool");
    const total = await pool2.query<{ cnt: string; gross: string; fee: string; net: string }>(
      `SELECT COUNT(*) AS cnt, COALESCE(SUM(gross_cents),0) AS gross, COALESCE(SUM(platform_fee_cents),0) AS fee, COALESCE(SUM(dev_net_cents),0) AS net
       FROM market_sales_record`,
    );
    const byPlugin = await pool2.query(
      `SELECT plugin_name, COUNT(*)::int AS orders, SUM(gross_cents)::int AS gross_cents,
              SUM(platform_fee_cents)::int AS platform_fee_cents, SUM(dev_net_cents)::int AS dev_net_cents
       FROM market_sales_record GROUP BY plugin_name ORDER BY gross_cents DESC LIMIT 50`,
    );
    const t = total.rows[0];
    return c.json({
      code: 0,
      data: {
        total: { orders: Number(t.cnt), gross_cents: Number(t.gross), platform_fee_cents: Number(t.fee), dev_net_cents: Number(t.net) },
        by_plugin: byPlugin.rows,
      },
    });
  });

  adm.get("/api/admin/sales/export", async (c) => {
    const month = /^\d{4}-\d{2}$/.test(String(c.req.query("month") ?? "")) ? String(c.req.query("month")) : null;
    const pool2 = c.get("pool");
    const params: unknown[] = [];
    let where = "";
    if (month) {
      const start = Date.parse(`${month}-01T00:00:00Z`);
      const end = new Date(start); end.setUTCMonth(end.getUTCMonth() + 1);
      where = ` WHERE s.created_at >= $1 AND s.created_at < $2`;
      params.push(start, end.getTime());
    }
    const r = await pool2.query(
      `SELECT s.order_no, s.plugin_name, a.email AS developer, p.licensee, p.account_id,
              s.gross_cents, s.platform_fee_cents, s.dev_net_cents, s.created_at
       FROM market_sales_record s
       LEFT JOIN market_account a ON a.id = s.developer_id
       LEFT JOIN market_pay_order p ON p.out_trade_no = s.order_no${where}
       ORDER BY s.id ASC LIMIT 5000`,
      params,
    );
    const esc = (v: unknown) => {
      const s = v === null || v === undefined ? "" : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = ["订单号,插件,开发者,授权域名,毛额(分),平台费(分),开发者净额(分),时间"];
    for (const row of r.rows as Array<Record<string, unknown>>) {
      lines.push([row.order_no, row.plugin_name, row.developer ?? "平台(SVIP)", row.licensee ?? "",
        row.gross_cents, row.platform_fee_cents, row.dev_net_cents,
        new Date(Number(row.created_at)).toISOString()].map(esc).join(","));
    }
    return new Response("\uFEFF" + lines.join("\r\n") + "\r\n", {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="market-sales${month ? "-" + month : ""}.csv"`,
      },
    });
  });

  adm.get("/api/admin/licenses", async (c) => {
    const r = await c.get("pool").query(
      `SELECT l.id, l.license_type, l.plugin_name, l.licensee, l.issued_at, l.expires_at, l.state, l.order_no,
              a.email AS buyer
       FROM market_license l LEFT JOIN market_account a ON a.id = l.account_id
       ORDER BY l.id DESC LIMIT 200`,
    );
    return c.json({ code: 0, data: r.rows });
  });

  adm.post("/api/admin/licenses/revoke", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { id?: number; reason?: string } | null;
    const id = Number(body?.id ?? 0);
    const reason = String(body?.reason ?? "").slice(0, 500);
    if (!id || reason.length < 5) return c.json({ code: 400, msg: "id/reason(≥5字) required" }, 400);
    const r = await c.get("pool").query(
      `UPDATE market_license SET state = 1 WHERE id = $1 AND state = 0 RETURNING id, plugin_name, licensee`,
      [id],
    );
    if (!r.rowCount) return c.json({ code: 409, msg: "license 不存在或已作废" }, 409);
    const row = r.rows[0] as { plugin_name: string | null; licensee: string };
    console.log(`[license] 作废 #${id} ${row.plugin_name ?? "svip"}@${row.licensee}：${reason}`);
    return c.json({ code: 0, msg: `已作废 #${id}（注意：已装实例不回收，仅解除市场侧授权与重购限制）` });
  });

  /** 重签全部有效 license（钥轮换配套：宿主换钥+重启后调用；用户需重新下载 .lic）。 */
  adm.post("/api/admin/licenses/reissue-all", async (c) => {
    const pool2 = c.get("pool");
    const r = await pool2.query<{ id: string; license_type: string; plugin_name: string | null; licensee: string; account_id: string; expires_at: string | null }>(
      `SELECT id, license_type, plugin_name, licensee, account_id, expires_at FROM market_license WHERE state = 0`,
    );
    let n = 0;
    for (const row of r.rows) {
      const lic = issueLicense({
        type: row.license_type as "plugin" | "svip",
        plugin: row.plugin_name ?? null,
        licensee: row.licensee,
        account: Number(row.account_id),
        expires_at: row.expires_at ? Number(row.expires_at) : null,
      });
      await pool2.query(
        `UPDATE market_license SET payload = $1, sig = $2, issued_at = $3 WHERE id = $4`,
        [JSON.stringify(lic.payload), lic.sig, lic.payload.issued_at, Number(row.id)],
      );
      n++;
    }
    return c.json({ code: 0, msg: `已用当前私钥重签 ${n} 份有效 license（请同步更新各店铺 GQSHOP_LICENSE_PUBKEY 并让用户重新下载）`, data: { reissued: n } });
  });

  adm.post("/api/admin/unpublish", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { name?: string } | null;
    const name = String(body?.name ?? "");
    if (!/^[a-z][a-z0-9_]{2,49}$/.test(name)) return c.json({ code: 400, msg: "name 不合法" }, 400);
    const removed = unpublishPlugin(name);
    if (!removed) return c.json({ code: 404, msg: "index 中无此插件" }, 404);
    return c.json({ code: 0, msg: `已下架 ${name}（移除 ${removed} 条；已装实例不回收，恢复=提交新版本过审）` });
  });

  adm.post("/api/admin/developers", async (c) => {    const body = (await c.req.json().catch(() => null)) as { id?: number; action?: string } | null;
    const id = Number(body?.id ?? 0);
    const action = body?.action === "approve" ? "approve" : body?.action === "reject" ? "reject" : "";
    if (!id || !action) return c.json({ code: 400, msg: "id/action(approve|reject) required" }, 400);
    if (action === "approve") {
      await c.get("pool").query(
        `UPDATE market_account SET role = 'developer', dev_pending = FALSE WHERE id = $1 AND role = 'customer'`,
        [id],
      );
      return c.json({ code: 0, msg: "已开通 developer" });
    }
    await c.get("pool").query(`UPDATE market_account SET dev_pending = FALSE WHERE id = $1`, [id]);
    return c.json({ code: 0, msg: "已拒绝申请" });
  });
  app.route("/", adm);

  app.notFound((c) => c.json({ code: 404, msg: "not found" }, 404));
  return app;
}
