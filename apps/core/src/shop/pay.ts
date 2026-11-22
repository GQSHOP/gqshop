/**
 * M1 支付域：余额支付（原子扣款 A1）+ 易支付回调（验签 A3）+ mock 网关（staging 联调）。
 * A2 铁律：发货失败不回滚支付状态（订单停在已支付待发货 1/1 并告警）。
 */
import { Hono } from "hono";

import type { AppEnv } from "../index.js";
import { epayConfigFromEnv, publicBaseFromEnv, assertPublicHttpUrl } from "../lib/epay-config.js";
import { EPAY_TRADE_SUCCESS, epaySign, epayTypeFromPlugin, epayVerify } from "../lib/epay.js";
import { verifyToken } from "../lib/jwt.js";
import { centsToYuan, yuanToCents } from "../lib/trade.js";
import { payCommissionChain } from "../lib/commission.js";
import { bus } from "../lib/plugin-host.js";
import { payStationIncome } from "../lib/station-income.js";
import { createPhysicalSale } from "../physical.js";
import { deliverOrderItem } from "./deliver.js";

export const payRoutes = new Hono<AppEnv>();

/** 易支付跳转支付：按订单构建签名 submit URL（协议 1:1，A4）。
 *  支付类型从订单 pay_plugin 推导（下单时用户选择已入库），不信任客户端 query。 */
payRoutes.get("/v1/pay/epay/submit", async (c) => {
  const cfg = epayConfigFromEnv();
  if (!cfg) return c.json({ code: 501, msg: "epay not configured" }, 501);
  const pool = c.get("pool");
  const no = (c.req.query("out_trade_no") ?? "").slice(0, 30);
  if (!no) return c.json({ code: 400, msg: "out_trade_no required" }, 400);

  const o = await pool.query(
    `SELECT out_trade_no, amount, status, pay_plugin FROM dc_order WHERE out_trade_no = $1 AND delete_time IS NULL`,
    [no],
  );
  const order = o.rows[0] as { out_trade_no: string; amount: number; status: number; pay_plugin: string | null } | undefined;
  if (!order) return c.json({ code: 404, msg: "order not found" }, 404);
  if (order.status === 2) return c.json({ code: 409, msg: "order already delivered" }, 409);
  const type = epayTypeFromPlugin(order.pay_plugin);
  if (!type) return c.json({ code: 400, msg: `order pay_plugin ${order.pay_plugin} is not an epay channel` }, 400);

  const base = publicBaseFromEnv();
  const goodsTitle = await pool.query(
    `SELECT g.title FROM dc_order_list ol LEFT JOIN dc_goods g ON g.id = ol.goods_id
     WHERE ol.order_id = (SELECT id FROM dc_order WHERE out_trade_no = $1) LIMIT 1`,
    [no],
  );
  const name = String(goodsTitle.rows[0]?.title ?? "GQSHOP order").slice(0, 100);

  const params: Record<string, string> = {
    pid: cfg.pid,
    type,
    out_trade_no: order.out_trade_no,
    notify_url: `${base}/v1/pay/notify/epay`,
    return_url: `${base}/result/${order.out_trade_no}`,
    name,
    money: centsToYuan(order.amount),
    sitename: "GQSHOP",
  };
  const sign = epaySign(params, cfg.key);
  const qs = new URLSearchParams({ ...params, sign, sign_type: "MD5" }).toString();
  const submitUrl = `${cfg.api}/submit.php?${qs}`;

  // 网关握手：该网关 submit.php 返回 JSON {payurl, qrcode}（已实测），服务端代取代支付页
  // SSRF 防线：目标 URL 出站前白名单校验（公网 http/s），并禁止跟随重定向（302 不可被引向内网）
  const gwTarget = assertPublicHttpUrl(submitUrl);
  const gw = await fetch(gwTarget, {
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  });
  if (!gw.ok) {
    return c.json({ code: 502, msg: `gateway http ${gw.status}` }, 502);
  }
  const gwBody = (await gw.json().catch(() => null)) as
    | { code?: number; msg?: string; payurl?: string; qrcode?: string; trade_no?: string }
    | null;
  if (!gwBody || gwBody.code !== 1 || !gwBody.payurl) {
    return c.json(
      { code: 502, msg: `gateway rejected: ${gwBody?.msg ?? "no payurl"}` },
      502,
    );
  }
  return c.json({
    code: 0,
    data: {
      pay_url: gwBody.payurl,
      qrcode: gwBody.qrcode ?? gwBody.payurl,
      trade_no: gwBody.trade_no ?? "",
      type,
    },
  });
});

/** 余额支付鉴权：JWT -> uid。 */
payRoutes.use("/v1/shop/orders/:no/pay-balance", async (c, next) => {
  const auth = c.req.header("Authorization");
  const payload = auth?.startsWith("Bearer ")
    ? await verifyToken(c.get("jwtSecret"), auth.slice(7))
    : null;
  if (!payload) return c.json({ code: 401, msg: "login required" }, 401);
  c.set("uid", payload.uid);
  await next();
});

/**
 * 支付成功后的统一履约（审查修复 H1）：逐子项发货（A2：失败不回滚支付）→ 状态推进 →
 * 佣金链 → 分店分成 → 实物发货单。settlePayment（网关/mock）与余额支付共用，
 * 保证两条支付路径的后置资金动作完全一致。
 * 事务语义：executor=结算方持有的 client；deliverOrderItem 内部自捕获错误（永不抛），
 * 仅 PG 级故障会随外层事务回滚——领卡与支付标记同生共死（审查修复 M3，杜绝重试双发）。
 */
export async function fulfillOrderAfterPaid(
  client: import("pg").PoolClient,
  pool: import("pg").Pool,
  order: { id: number; user_id: number; amount: number; out_trade_no?: string },
): Promise<boolean> {
  const items = await client.query(
    `SELECT ol.id, ol.goods_id, ol.sku, ol.quantity, g.type AS goods_type
     FROM dc_order_list ol LEFT JOIN dc_goods g ON g.id = ol.goods_id
     WHERE ol.order_id = $1`,
    [order.id],
  );
  let allDelivered = true;
  for (const item of items.rows) {
    const r = await deliverOrderItem(client, order.id, item, (item.goods_type as string) ?? "");
    if (!r.delivered) {
      allDelivered = false;
      console.error(`[pay] deliver failed for order ${order.out_trade_no ?? order.id}: ${r.error}`);
      continue;
    }
    await client.query(`UPDATE dc_order_list SET status = 2 WHERE id = $1`, [item.id]);
    const stock = await client.query<{ stock: number }>(
      `UPDATE dc_goods SET sales = sales + $1 WHERE id = $2 RETURNING stock`,
      [item.quantity ?? 1, item.goods_id],
    );
    // 库存低预警钩子（对齐上游 stock_low_warning 语义，阈值 10）
    const curStock = Number(stock.rows[0]?.stock ?? 0);
    if (curStock <= 10) {
      await bus.emit("stock:low", { goodsId: item.goods_id ?? 0, stock: curStock });
    }
  }
  if (allDelivered) {
    await client.query(`UPDATE dc_order SET status = 2, update_time = $2 WHERE id = $1`, [
      order.id,
      Date.now(),
    ]);
  }
  // 分销佣金（M7 C1 对齐上游真算法）：池=基数×ratio（commission_base total/profit 用成本差）、
  // 池递减链 + 起提线 + 池帽 + 等级门槛/跳级；分店订单默认与链互斥（level_commits_distribute）
  const stn = await client.query<{ station_id: number; owner_uid: number | null }>(
    `SELECT o.station_id, s.user_id AS owner_uid
     FROM dc_order o LEFT JOIN dc_station s ON s.id = o.station_id
     WHERE o.id = $1`,
    [order.id],
  );
  const stationOwnerUid = stn.rows[0]?.owner_uid ?? 0;
  let costCents = 0;
  if (order.user_id > 0) {
    const cost = await client.query<{ c: string | null }>(
      `SELECT COALESCE(SUM(COALESCE(sk.cost_price, 0) * ol.quantity), 0) AS c
       FROM dc_order_list ol
       LEFT JOIN dc_skus sk ON sk.goods_id = ol.goods_id AND sk.sku = ol.sku
       WHERE ol.order_id = $1`,
      [order.id],
    );
    costCents = Math.round(Number(cost.rows[0]?.c ?? 0));
  }
  await payCommissionChain(client, order.user_id, order.out_trade_no ?? String(order.id), order.amount, {
    costCents,
    stationOwnerUid,
  });
  // 分店分成（M3 D7）：分店主实得 = 实付 − 等级手续费率
  if (stn.rows[0]?.station_id) {
    await payStationIncome(client, order.id, stn.rows[0].station_id, order.amount);
  }
  // 实物发货单（ADR-005 P3）：支付成功建单，物流由 admin 发货页处理（幂等）
  await createPhysicalSale(client, order.id);
  return allDelivered;
}

/** 通用支付成功处理：条件更新订单 -> 逐子项发货 -> 状态推进。返回 {paid, delivered}。 */
export async function settlePayment(
  pool: import("pg").Pool,
  outTradeNo: string,
  gateway: string,
  paidAmountCents: number,
): Promise<{ paid: boolean; delivered: boolean; msg: string }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const o = await client.query(
      `SELECT id, out_trade_no, amount, pay_status, status, user_id FROM dc_order WHERE out_trade_no = $1 FOR UPDATE`,
      [outTradeNo],
    );
    const order = o.rows[0] as { id: number; out_trade_no: string; amount: number; pay_status: number; status: number; user_id: number } | undefined;
    if (!order) {
      await client.query("ROLLBACK");
      return { paid: false, delivered: false, msg: "order not found" };
    }
    // 超时关单后的迟到回调：恢复订单继续结算（A1），并补回关单时释放的库存
    if (order.status === 3 && order.pay_status === 0) {
      await client.query(`UPDATE dc_order SET status = 0 WHERE id = $1`, [order.id]);
      const rel = await client.query(
        `SELECT goods_id, quantity FROM dc_order_list WHERE order_id = $1`,
        [order.id],
      );
      for (const it of rel.rows) {
        const rs = await client.query(
          `UPDATE dc_goods SET stock = stock - $1 WHERE id = $2 AND stock >= $1`,
          [it.quantity ?? 1, it.goods_id],
        );
        if (rs.rowCount !== 1) {
          console.error(`[pay] late-callback stock reclaim failed: order ${outTradeNo} goods ${it.goods_id}`);
        }
      }
      order.status = 0;
    }
    if (order.amount !== paidAmountCents) {
      await client.query("ROLLBACK");
      return { paid: false, delivered: false, msg: "amount mismatch" };
    }
    if (order.pay_status !== 0) {
      await client.query("COMMIT");
      return { paid: true, delivered: false, msg: "already paid (idempotent)" };
    }
    await client.query(
      `UPDATE dc_order SET pay_status = 1, status = 1, pay_time = $2, update_time = $2,
              payment = $3 WHERE id = $1 AND pay_status = 0`,
      [order.id, Date.now(), gateway],
    );

    const allDelivered = await fulfillOrderAfterPaid(client, pool, order);
    await client.query("COMMIT");
    return { paid: true, delivered: allDelivered, msg: allDelivered ? "delivered" : "paid, delivery pending" };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("[pay] settle error:", err);
    return { paid: false, delivered: false, msg: "settle error" };
  } finally {
    client.release();
  }
}

/** 余额支付（登录态）。A1：扣款与校验一条语句。 */
payRoutes.post("/v1/shop/orders/:no/pay-balance", async (c) => {
  const uid = c.get("uid");
  if (!uid) return c.json({ code: 401, msg: "login required" }, 401);
  const pool = c.get("pool");
  const no = c.req.param("no").slice(0, 30);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // 审查修复 M1：只能支付本人下单的订单（user_id 匹配且非游客单 0）；
    // 审查修复 H2：只允许支付 status=0 待支付订单——已关单(status=3)订单的库存已释放，
    // 余额支付会造成超卖（网关迟到回调的恢复语义只适用于被动 notify，主动支付直接拒绝）
    const o = await client.query(
      `SELECT id, out_trade_no, amount, pay_status, status, user_id FROM dc_order
       WHERE out_trade_no = $1 AND user_id = $2 AND user_id <> 0 FOR UPDATE`,
      [no, uid],
    );
    const order = o.rows[0] as { id: number; amount: number; pay_status: number; status: number; user_id: number } | undefined;
    if (!order) throw Object.assign(new Error("order not found (or not yours)"), { http: 404 as const });
    if (order.pay_status !== 0) throw Object.assign(new Error("order already paid"), { http: 409 as const });
    if (order.status !== 0) throw Object.assign(new Error("order closed, please re-order"), { http: 409 as const });

    const yuan = centsToYuan(order.amount);
    const before = await client.query(`SELECT money FROM dc_user WHERE uid = $1 FOR UPDATE`, [uid]);
    const moneyBefore = before.rows[0]?.money as string | undefined;
    const deducted = await client.query(
      `UPDATE dc_user SET money = money - $1::numeric WHERE uid = $2 AND money >= $1::numeric RETURNING money`,
      [yuan, uid],
    );
    if (deducted.rowCount !== 1) {
      throw Object.assign(new Error("insufficient balance"), { http: 409 as const });
    }
    await client.query(
      `INSERT INTO dc_balance_log (user_id, plus, update_before, money, description, create_time)
       VALUES ($1, 'n', $2, $3, $4, $5)`,
      [uid, moneyBefore ?? "0.00", deducted.rows[0].money, `余额支付订单 ${no}`, Date.now()],
    );
    await client.query(
      `UPDATE dc_order SET pay_status = 1, status = 1, pay_time = $2, update_time = $2,
              payment = '余额支付', pay_plugin = 'balance' WHERE id = $1 AND pay_status = 0`,
      [order.id, Date.now()],
    );

    // 审查修复 H1：与网关结算同一条履约路径（发货+佣金+分店分成+实物发货单）
    const allDelivered = await fulfillOrderAfterPaid(client, pool, order);
    await client.query("COMMIT");
    return c.json({ code: 0, msg: allDelivered ? "delivered" : "paid, delivery pending" });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    const e = err as Error & { http?: 400 | 404 | 409 };
    const status: 200 | 400 | 404 | 409 | 500 = e.http ?? 500;
    return c.json({ code: status, msg: e.message }, status);
  } finally {
    client.release();
  }
});

/** 易支付异步回调（GET/POST 表单）。验签 + 金额校验 + 幂等 + 全量回调日志（A3）。 */
payRoutes.all("/v1/pay/notify/epay", async (c) => {
  const pool = c.get("pool");
  const key = process.env.GQSHOP_EPAY_KEY ?? "";
  const raw: Record<string, string> = {};
  for (const [k, v] of Object.entries(c.req.query())) raw[k] = String(v);
  const form = await c.req.parseBody().catch(() => ({}));
  for (const [k, v] of Object.entries(form)) {
    if (typeof v === "string") raw[k] = v;
  }

  await pool.query(
    `INSERT INTO dc_pay_callback_log (gateway, order_no, amount, status, raw_data, ip, create_time)
     VALUES ('epay', $1, $2, $3, $4, $5, $6)`,
    [
      String(raw.out_trade_no ?? "").slice(0, 64),
      String(raw.money ?? raw.total_fee ?? "").slice(0, 32),
      String(raw.trade_status ?? "").slice(0, 32),
      JSON.stringify(raw).slice(0, 5000),
      c.req.header("x-forwarded-for") ?? "",
      Math.floor(Date.now() / 1000),
    ],
  );

  if (!key) return c.text("fail");
  if (!epayVerify(raw, key)) return c.text("fail");
  if (raw.trade_status !== EPAY_TRADE_SUCCESS) return c.text("success");

  const cents = yuanToCents(raw.money ?? raw.total_fee ?? "0");
  const r = await settlePayment(pool, String(raw.out_trade_no ?? ""), "epay", cents);
  return c.text(r.paid ? "success" : "fail");
});

/** mock 网关（仅 GQSHOP_PAY_MOCK=1 的 staging）：模拟网关回调成功。 */
payRoutes.post("/v1/pay/mock/confirm", async (c) => {
  if (process.env.GQSHOP_PAY_MOCK !== "1") {
    return c.json({ code: 404, msg: "mock disabled" }, 404);
  }
  const adminKey = process.env.GQSHOP_ADMIN_KEY ?? "";
  if (!adminKey || c.req.header("X-Admin-Key") !== adminKey) {
    return c.json({ code: 403, msg: "admin key required" }, 403);
  }
  const pool = c.get("pool");
  const body = (await c.req.json().catch(() => null)) as { out_trade_no?: string } | null;
  const no = String(body?.out_trade_no ?? "").slice(0, 30);
  if (!no) return c.json({ code: 400, msg: "out_trade_no required" }, 400);
  const o = await pool.query(`SELECT amount FROM dc_order WHERE out_trade_no = $1`, [no]);
  const amount = o.rows[0]?.amount as number | undefined;
  if (amount === undefined) return c.json({ code: 404, msg: "order not found" }, 404);
  const r = await settlePayment(pool, no, "mock", amount);
  return c.json({ code: r.paid ? 0 : 500, msg: r.msg, delivered: r.delivered }, r.paid ? 200 : 500);
});
