/**
 * M3 分店路由（ADR-004）：
 *   GET  /v1/shop/station-levels        — 等级列表（公开）
 *   POST /v1/user/station/open          — 自助开通（余额，level_order purchase_type='station'）
 *   GET  /v1/user/station               — 我的分店
 *   PATCH /v1/user/station/profile      — 店铺资料（drizzle 白名单 setter，零 SQL 拼接）
 *   POST /v1/user/station/domain        — 绑定独立域名（受 is_domain；保留前缀/占用校验）
 *   GET  /v1/admin/station              — 分店列表
 *   PATCH /v1/admin/station/:id/status  — 停用/启用
 *   GET  /v1/admin/station/stats        — 手续费/分成统计
 */
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { Hono } from "hono";

import { stationTable } from "@gqshop/db";
import type { AppEnv } from "./index.js";
import { requireAuth } from "./lib/jwt.js";
import { adminPermGuard } from "./lib/admin-auth.js";
import { getRegistry } from "./lib/templates.js";
import { SLUG_RESERVED, yuanToCentsHalfUp } from "./station.js";

export const stationRoutes = new Hono<AppEnv>();

const RESERVED_DOMAIN_PREFIX = ["www", "m", "api", "admin", "mail", "ftp"];

/** 等级列表（公开）。 */
/** 分店上下文（公开）：slug 或域名解析激活分店，店面据此渲染分店品牌。 */
stationRoutes.get("/v1/shop/station-context", async (c) => {
  const pool = c.get("pool");
  const slug = (c.req.query("slug") ?? "").slice(0, 50);
  const host = ((c.req.query("host") ?? c.req.header("x-forwarded-host") ?? "").split(":")[0] ?? "").slice(0, 100);
  if (!slug && !host) return c.json({ code: 400, msg: "slug or host required" }, 400);
  const res = await pool.query(
    // 审查修复 L3：域名解析同时匹配 domain/domain_2（绑定查重已查双列，解析侧对齐）
    `SELECT id, slug, name, title, site_subtitle, roll_notice, home_notice, status
     FROM dc_station WHERE delete_time IS NULL AND ( ($1::varchar <> '' AND slug = $1::varchar) OR ($2::varchar <> '' AND (domain = $2::varchar OR domain_2 = $2::varchar)) ) LIMIT 1`,
    [slug, host],
  );
  const st = res.rows[0] as { id: number; slug: string; name: string; title: string | null; site_subtitle: string | null; roll_notice: string | null; home_notice: string | null; status: number } | undefined;
  if (!st || st.status !== 1) return c.json({ code: 404, msg: "station not found or inactive" }, 404);
  return c.json({
    code: 0,
    data: {
      station_id: st.id, slug: st.slug, name: st.name,
      title: st.title || st.name, site_subtitle: st.site_subtitle ?? "",
      roll_notice: st.roll_notice ?? "", home_notice: st.home_notice ?? "",
    },
  });
});

stationRoutes.get("/v1/shop/station-levels", async (c) => {
  const pool = c.get("pool");
  const rows = await pool.query(
    `SELECT id, name, icon, price, description, service_change, cash_change,
            is_domain, is_goods, perm_setprice, perm_goodsstate, perm_tpl, perm_config, perm_deposit
     FROM dc_station_level WHERE "using" = 'y' ORDER BY sort ASC`,
  );
  return c.json({ code: 0, data: rows.rows });
});

/** genSlug：随机 8 位（crypto，非安全凭证但避免可预测抢注）。 */
function genSlug(): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  const bytes = randomBytes(8);
  let s = "";
  for (let i = 0; i < 8; i++) {
    const b = bytes[i];
    if (b === undefined) break;
    s += alphabet[b % alphabet.length];
  }
  return s;
}

/** genStationTradeNo：GS 前缀订单号（对齐 lib/trade.ts genOutTradeNo）。 */
function genStationTradeNo(): string {
  const t = Date.now().toString();
  return `GS${t}${randomBytes(4).toString("hex").toUpperCase()}`.slice(0, 32);
}

/** 自助开通（余额；上游：仅钱包余额支付）。 */
stationRoutes.post("/v1/user/station/open", requireAuth(), async (c) => {
  const uid = c.get("uid");
  if (!uid) return c.json({ code: 401, msg: "login required" }, 401);
  const pool = c.get("pool");
  const body = (await c.req.json().catch(() => null)) as
    | { level_id?: number; slug?: string; name?: string; title?: string }
    | null;
  const levelId = Number(body?.level_id);
  if (!Number.isInteger(levelId) || levelId <= 0) {
    return c.json({ code: 400, msg: "level_id required" }, 400);
  }
  const slug = (body?.slug ?? "").trim().toLowerCase().slice(0, 50);
  if (slug && !/^[a-z0-9_-]{2,50}$/.test(slug)) {
    return c.json({ code: 400, msg: "slug must be 2-50 chars [a-z0-9_-]" }, 400);
  }
  if (slug && SLUG_RESERVED.has(slug)) {
    return c.json({ code: 400, msg: "slug reserved" }, 400);
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const lv = await client.query(
      `SELECT id, name, price FROM dc_station_level WHERE id = $1 AND "using" = 'y' FOR UPDATE`,
      [levelId],
    );
    const level = lv.rows[0] as { id: number; name: string; price: string } | undefined;
    if (!level) throw Object.assign(new Error("station level not found"), { http: 404 });

    // 一个用户一家店（上游语义：uid 维度一店）
    const exist = await client.query(
      `SELECT id FROM dc_station WHERE user_id = $1 AND delete_time IS NULL FOR UPDATE`,
      [uid],
    );
    if (exist.rows.length > 0) throw Object.assign(new Error("station already exists"), { http: 409 });

    // slug 唯一
    const finalSlug = slug || genSlug();
    const slugTaken = await client.query(
      `SELECT id FROM dc_station WHERE lower(slug) = $1 AND delete_time IS NULL`,
      [finalSlug],
    );
    if (slugTaken.rows.length > 0) throw Object.assign(new Error("slug taken"), { http: 409 });

    // 余额扣款（0 元等级免费开通）
    const priceCents = yuanToCentsHalfUp(level.price);
    const now = Date.now();
    if (priceCents > 0) {
      const priceYuan = (priceCents / 100).toFixed(2);
      const me = await client.query<{ money: string }>(
        `SELECT money FROM dc_user WHERE uid = $1 FOR UPDATE`,
        [uid],
      );
      const before = me.rows[0]?.money ?? "0";
      const deducted = await client.query<{ money: string }>(
        `UPDATE dc_user SET money = money - $1::numeric WHERE uid = $2 AND money >= $1::numeric RETURNING money`,
        [priceYuan, uid],
      );
      if (deducted.rowCount !== 1) throw Object.assign(new Error("insufficient balance"), { http: 409 });
      const afterMoney = deducted.rows[0]?.money ?? "0";
      await client.query(
        `INSERT INTO dc_balance_log (user_id, plus, update_before, money, description, create_time)
         VALUES ($1, 'n', $2, $3, $4, $5)`,
        [uid, before, afterMoney, `开通分店 ${level.name}`, now],
      );
    }

    const outTradeNo = genStationTradeNo();
    await client.query(
      `INSERT INTO dc_level_order (out_trade_no, user_id, level_id, purchase_type, duration_days,
                                   amount, base_price, old_level_id, old_expire_time, new_expire_time,
                                   state, create_time, complete_time)
       VALUES ($1, $2, $3, 'station', 0, $4, $4, 0, 0, 0, 1, $5, $5)`,
      [outTradeNo, uid, levelId, (priceCents / 100).toFixed(2), now],
    );

    const st = await client.query<{ id: number; slug: string }>(
      `INSERT INTO dc_station (user_id, level_id, status, amount, slug, name, title, create_time, master_sort, master_goods)
       VALUES ($1, $2, 1, $3, $4, $5, $6, $7, 1, 1) RETURNING id, slug`,
      [uid, levelId, (priceCents / 100).toFixed(2), finalSlug,
        (body?.name ?? "").slice(0, 50) || null, (body?.title ?? "").slice(0, 200) || null, now],
    );
    // master_sort/master_goods=1：默认同步主站全量分类/商品（映射表空=全同步，上游语义）
    await client.query("COMMIT");
    const created = st.rows[0] as { id: number; slug: string } | undefined;
    return c.json({
      code: 0, msg: "ok",
      data: { station_id: created?.id, slug: created?.slug, level: level.name, out_trade_no: outTradeNo },
    }, 201);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    const e = err as Error & { http?: 400 | 404 | 409 };
    const status: 200 | 400 | 404 | 409 | 500 = e.http ?? 500;
    if (status === 500) console.error("[station] open failed:", e.message);
    return c.json({ code: status, msg: e.message }, status);
  } finally {
    client.release();
  }
});

/** 我的分店（店主视图）。 */
stationRoutes.get("/v1/user/station", requireAuth(), async (c) => {
  const uid = c.get("uid");
  if (!uid) return c.json({ code: 401, msg: "login required" }, 401);
  const pool = c.get("pool");
  const r = await pool.query(
    `SELECT s.id, s.slug, s.name, s.title, s.status, s.domain, s.create_time, s.level_id,
            s.logo, s.site_subtitle, s.roll_notice, s.home_notice, s.footer_info,
            l.name AS level_name, l.service_change, l.cash_change,
            l.perm_setprice, l.perm_goodsstate, l.perm_tpl, l.perm_config, l.perm_deposit,
            l.is_domain, l.is_goods
     FROM dc_station s LEFT JOIN dc_station_level l ON l.id = s.level_id
     WHERE s.user_id = $1 AND s.delete_time IS NULL`,
    [uid],
  );
  const station = r.rows[0];
  if (!station) return c.json({ code: 404, msg: "no station" }, 404);
  // 收益统计（已结算入账的分成）
  const inc = await pool.query(
    `SELECT COALESCE(SUM(money), 0) AS total FROM dc_balance_log
     WHERE user_id = $1 AND plus = 'y' AND description LIKE '分店订单分成 %'`,
    [uid],
  );
  return c.json({ code: 0, data: { ...station, income_total: inc.rows[0].total } });
});

/**
 * 店铺资料更新：drizzle 白名单 setter 映射——列名是编译期对象字段，
 * 用户值走 drizzle 参数化 set，无任何 SQL 字符串拼接。
 */
stationRoutes.patch("/v1/user/station/profile", requireAuth(), async (c) => {
  const uid = c.get("uid");
  if (!uid) return c.json({ code: 401, msg: "login required" }, 401);
  const db = c.get("db");
  const pool = c.get("pool");
  const body = (await c.req.json().catch(() => null)) as Record<string, string | undefined> | null;
  const s = await pool.query<{ id: number }>(
    `SELECT id FROM dc_station WHERE user_id = $1 AND delete_time IS NULL AND status = 1`,
    [uid],
  );
  if (!s.rows[0]) return c.json({ code: 404, msg: "no active station" }, 404);
  const stationId = s.rows[0].id;

  const sets: Partial<typeof stationTable.$inferInsert> = {};
  if (typeof body?.name === "string") sets.name = body.name.slice(0, 50);
  if (typeof body?.title === "string") sets.title = body.title.slice(0, 200);
  if (typeof body?.site_subtitle === "string") sets.site_subtitle = body.site_subtitle.slice(0, 200);
  if (typeof body?.logo === "string") sets.logo = body.logo.slice(0, 500);
  if (typeof body?.favicon === "string") sets.favicon = body.favicon.slice(0, 500);
  if (typeof body?.roll_notice === "string") sets.roll_notice = body.roll_notice.slice(0, 2000);
  if (typeof body?.home_notice === "string") sets.home_notice = body.home_notice.slice(0, 4000);
  if (typeof body?.footer_info === "string") sets.footer_info = body.footer_info.slice(0, 4000);
  if (Object.keys(sets).length === 0) return c.json({ code: 400, msg: "nothing to update" }, 400);
  await db.update(stationTable).set(sets).where(eq(stationTable.id, stationId));
  return c.json({ code: 0, msg: "ok" });
});

/** 分店模板（M5-δ ADR-008 D1）：GET 当前+可选清单；POST 选择（perm_tpl='y' 等级才可换，
 *  写 dc_station_plugin type='pc' pc_switch='y'，plugin_name_en=模板名）。 */
stationRoutes.get("/v1/user/station/template", requireAuth(), async (c) => {
  const uid = c.get("uid");
  if (!uid) return c.json({ code: 401, msg: "login required" }, 401);
  const pool = c.get("pool");
  const s = await pool.query<{ id: number; perm_tpl: string | null; current: string | null }>(
    `SELECT s.id, l.perm_tpl,
            (SELECT plugin_name_en FROM dc_station_plugin WHERE station_id = s.id AND type = 'pc' AND pc_switch = 'y' LIMIT 1) AS current
     FROM dc_station s LEFT JOIN dc_station_level l ON l.id = s.level_id
     WHERE s.user_id = $1 AND s.delete_time IS NULL AND s.status = 1`,
    [uid],
  );
  const st = s.rows[0];
  if (!st) return c.json({ code: 404, msg: "no active station" }, 404);
  const reg = getRegistry();
  return c.json({
    code: 0,
    data: {
      current: st.current ?? "default",
      can_pick: st.perm_tpl === "y",
      templates: reg ? [...reg.templates.keys()] : ["default"],
    },
  });
});

stationRoutes.post("/v1/user/station/template", requireAuth(), async (c) => {
  const uid = c.get("uid");
  if (!uid) return c.json({ code: 401, msg: "login required" }, 401);
  const pool = c.get("pool");
  const body = (await c.req.json().catch(() => null)) as { template?: string } | null;
  const name = String(body?.template ?? "").trim().slice(0, 50);
  const reg = getRegistry();
  if (!reg || !reg.templates.has(name)) {
    return c.json({ code: 400, msg: `template not registered: ${name}` }, 400);
  }
  const s = await pool.query<{ id: number; perm_tpl: string | null }>(
    `SELECT s.id, l.perm_tpl FROM dc_station s LEFT JOIN dc_station_level l ON l.id = s.level_id
     WHERE s.user_id = $1 AND s.delete_time IS NULL AND s.status = 1`,
    [uid],
  );
  const st = s.rows[0];
  if (!st) return c.json({ code: 404, msg: "no active station" }, 404);
  if (st.perm_tpl !== "y") {
    return c.json({ code: 403, msg: "等级不支持自定义模板（perm_tpl=n，强制 default）" }, 403);
  }
  await pool.query(`DELETE FROM dc_station_plugin WHERE station_id = $1 AND type = 'pc'`, [st.id]);
  await pool.query(
    `INSERT INTO dc_station_plugin (station_id, plugin_id, plugin_name_cn, plugin_name_en, type, pc_switch, tel_switch)
     VALUES ($1, 0, $2, $2, 'pc', 'y', 'y')`,
    [st.id, name],
  );
  return c.json({ code: 0, msg: "ok", data: { template: name } });
});

/** 域名绑定（D3：保留前缀 + 环回/纯 IP 拒绝 + 占用校验；is_domain 权限位）。 */
stationRoutes.post("/v1/user/station/domain", requireAuth(), async (c) => {
  const uid = c.get("uid");
  if (!uid) return c.json({ code: 401, msg: "login required" }, 401);
  const pool = c.get("pool");
  const body = (await c.req.json().catch(() => null)) as { domain?: string } | null;
  const domain = (body?.domain ?? "").trim().toLowerCase().slice(0, 100);
  if (!/^[a-z0-9.-]{3,100}$/.test(domain)) {
    return c.json({ code: 400, msg: "invalid domain" }, 400);
  }
  const s = await pool.query<{ id: number; is_domain: string | null }>(
    `SELECT s.id, l.is_domain FROM dc_station s LEFT JOIN dc_station_level l ON l.id = s.level_id
     WHERE s.user_id = $1 AND s.delete_time IS NULL AND s.status = 1`,
    [uid],
  );
  const st = s.rows[0];
  if (!st) return c.json({ code: 404, msg: "no active station" }, 404);
  if (st.is_domain !== "y") return c.json({ code: 403, msg: "level does not allow domain" }, 403);

  const firstLabel = domain.split(".")[0] ?? "";
  if (RESERVED_DOMAIN_PREFIX.includes(firstLabel)) {
    return c.json({ code: 400, msg: "reserved prefix" }, 400);
  }
  // 拒绝环回/内网字面量（CNAME 接入的域名不做 IP 解析，仅挡典型滥用）
  if (domain.endsWith(".localhost") || domain === "localhost" || /^\d+\.\d+\.\d+\.\d+$/.test(domain)) {
    return c.json({ code: 400, msg: "invalid domain" }, 400);
  }
  const dup = await pool.query(
    `SELECT id FROM dc_station WHERE (lower(domain) = $1 OR lower(domain_2) = $1) AND delete_time IS NULL AND id <> $2`,
    [domain, st.id],
  );
  if (dup.rows.length > 0) return c.json({ code: 409, msg: "domain taken" }, 409);

  await pool.query(`UPDATE dc_station SET domain = $1 WHERE id = $2`, [domain, st.id]);
  return c.json({ code: 0, msg: "ok", data: { domain } });
});

// ============ 站主管理（M5-α：adminPermGuard 权限位 station.manage，认证兜底见 index.ts 全局中间件） ============

stationRoutes.get("/v1/admin/station", async (c) => {
  const denied = await adminPermGuard(c, "station.manage");
  if (denied) return denied;
  const pool = c.get("pool");
  const r = await pool.query(
    `SELECT s.id, s.user_id, s.slug, s.name, s.title, s.status, s.domain, s.amount, s.create_time,
            u.username, l.name AS level_name
     FROM dc_station s
     LEFT JOIN dc_user u ON u.uid = s.user_id
     LEFT JOIN dc_station_level l ON l.id = s.level_id
     WHERE s.delete_time IS NULL ORDER BY s.id DESC LIMIT 100`,
  );
  return c.json({ code: 0, data: r.rows });
});

stationRoutes.patch("/v1/admin/station/:id/status", async (c) => {
  const denied = await adminPermGuard(c, "station.manage");
  if (denied) return denied;
  const pool = c.get("pool");
  const id = Number(c.req.param("id"));
  const body = (await c.req.json().catch(() => null)) as { status?: number } | null;
  const status = body?.status === 0 ? 0 : 1;
  const r = await pool.query(
    `UPDATE dc_station SET status = $1 WHERE id = $2 AND delete_time IS NULL RETURNING id, status`,
    [status, id],
  );
  if (!r.rows[0]) return c.json({ code: 404, msg: "not found" }, 404);
  return c.json({ code: 0, msg: "ok", data: r.rows[0] });
});

/** 手续费/分成统计。 */
stationRoutes.get("/v1/admin/station/stats", async (c) => {
  const denied = await adminPermGuard(c, "station.manage");
  if (denied) return denied;
  const pool = c.get("pool");
  const r = await pool.query(
    `SELECT s.id, s.slug, s.name, l.name AS level_name, l.service_change,
            COALESCE(SUM(o.amount), 0)::bigint AS sales_total,
            COUNT(o.id)::int AS order_count
     FROM dc_station s
     LEFT JOIN dc_station_level l ON l.id = s.level_id
     LEFT JOIN dc_order o ON o.station_id = s.id AND o.pay_status = 1
     WHERE s.delete_time IS NULL
     GROUP BY s.id, s.slug, s.name, l.name, l.service_change
     ORDER BY s.id ASC`,
  );
  return c.json({ code: 0, data: r.rows });
});
