/**
 * 支付域：余额支付（原子扣款 A1）+ mock 网关（staging 联调）+ 统一履约/结算。
 * 易支付 submit/notify 路由已迁 pay-epay 插件（M6-γ 完全插件化，ADR-011 M6）。
 * A2 铁律：发货失败不回滚支付状态（订单停在已支付待发货 1/1 并告警）。
 */
import { Hono } from "hono";

import type { AppEnv } from "@gqshop/kernel";
import { verifyToken, centsToYuan, bus } from "@gqshop/kernel";
import { deliverOrderItem } from "./deliver.js";

export const payRoutes = new Hono<AppEnv>();

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
     FROM gq_order_list ol LEFT JOIN gq_goods g ON g.id = ol.goods_id
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
    await client.query(`UPDATE gq_order_list SET status = 2 WHERE id = $1`, [item.id]);
    const stock = await client.query<{ stock: number }>(
      `UPDATE gq_goods SET sales = sales + $1 WHERE id = $2 RETURNING stock`,
      [item.quantity ?? 1, item.goods_id],
    );
    // 库存低预警钩子（对齐上游 stock_low_warning 语义，阈值 10）
    const curStock = Number(stock.rows[0]?.stock ?? 0);
    if (curStock <= 10) {
      await bus.emit("stock:low", { goodsId: item.goods_id ?? 0, stock: curStock });
    }
  }
  if (allDelivered) {
    await client.query(`UPDATE gq_order SET status = 2, update_time = $2 WHERE id = $1`, [
      order.id,
      Date.now(),
    ]);
  }
  // R2-β：后置资金动作（佣金/分店分成/实物发货单）事件化——members/station/content
  // 域订阅执行；executor=本事务 client，入账与结算同生共死（原子性保持）。
  const stn = await client.query<{ station_id: number; owner_uid: number | null }>(
    `SELECT o.station_id, s.user_id AS owner_uid
     FROM gq_order o LEFT JOIN gq_station s ON s.id = o.station_id
     WHERE o.id = $1`,
    [order.id],
  );
  let costCents = 0;
  if (order.user_id > 0) {
    const cost = await client.query<{ c: string | null }>(
      `SELECT COALESCE(SUM(COALESCE(sk.cost_price, 0) * ol.quantity), 0) AS c
       FROM gq_order_list ol
       LEFT JOIN gq_skus sk ON sk.goods_id = ol.goods_id AND sk.sku = ol.sku
       WHERE ol.order_id = $1`,
      [order.id],
    );
    costCents = Math.round(Number(cost.rows[0]?.c ?? 0));
  }
  await bus.emit("pay:settled", {
    orderId: order.id,
    gateway: "",
    amountCents: order.amount,
    outTradeNo: order.out_trade_no ?? String(order.id),
    buyerUid: order.user_id,
    costCents,
    stationId: stn.rows[0]?.station_id ?? 0,
    stationOwnerUid: stn.rows[0]?.owner_uid ?? 0,
    executor: client as never,
  });
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
      `SELECT id, out_trade_no, amount, pay_status, status, user_id FROM gq_order WHERE out_trade_no = $1 FOR UPDATE`,
      [outTradeNo],
    );
    const order = o.rows[0] as { id: number; out_trade_no: string; amount: number; pay_status: number; status: number; user_id: number } | undefined;
    if (!order) {
      await client.query("ROLLBACK");
      return { paid: false, delivered: false, msg: "order not found" };
    }
    // 超时关单后的迟到回调：恢复订单继续结算（A1），并补回关单时释放的库存
    if (order.status === 3 && order.pay_status === 0) {
      await client.query(`UPDATE gq_order SET status = 0 WHERE id = $1`, [order.id]);
      const rel = await client.query(
        `SELECT goods_id, quantity FROM gq_order_list WHERE order_id = $1`,
        [order.id],
      );
      for (const it of rel.rows) {
        const rs = await client.query(
          `UPDATE gq_goods SET stock = stock - $1 WHERE id = $2 AND stock >= $1`,
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
      `UPDATE gq_order SET pay_status = 1, status = 1, pay_time = $2, update_time = $2,
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
      `SELECT id, out_trade_no, amount, pay_status, status, user_id FROM gq_order
       WHERE out_trade_no = $1 AND user_id = $2 AND user_id <> 0 FOR UPDATE`,
      [no, uid],
    );
    const order = o.rows[0] as { id: number; amount: number; pay_status: number; status: number; user_id: number } | undefined;
    if (!order) throw Object.assign(new Error("order not found (or not yours)"), { http: 404 as const });
    if (order.pay_status !== 0) throw Object.assign(new Error("order already paid"), { http: 409 as const });
    if (order.status !== 0) throw Object.assign(new Error("order closed, please re-order"), { http: 409 as const });

    const yuan = centsToYuan(order.amount);
    const before = await client.query(`SELECT money FROM gq_user WHERE uid = $1 FOR UPDATE`, [uid]);
    const moneyBefore = before.rows[0]?.money as string | undefined;
    const deducted = await client.query(
      `UPDATE gq_user SET money = money - $1::numeric WHERE uid = $2 AND money >= $1::numeric RETURNING money`,
      [yuan, uid],
    );
    if (deducted.rowCount !== 1) {
      throw Object.assign(new Error("insufficient balance"), { http: 409 as const });
    }
    await client.query(
      `INSERT INTO gq_balance_log (user_id, plus, update_before, money, description, create_time)
       VALUES ($1, 'n', $2, $3, $4, $5)`,
      [uid, moneyBefore ?? "0.00", deducted.rows[0].money, `余额支付订单 ${no}`, Date.now()],
    );
    await client.query(
      `UPDATE gq_order SET pay_status = 1, status = 1, pay_time = $2, update_time = $2,
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

/** mock 网关（仅 GQSHOP_PAY_MOCK=1 的 staging）：模拟网关回调成功。
 *  v1.1.1 后全局机器通道已删，此端点是 X-Admin-Key 的仅存消费者（prod 不设 GQSHOP_ADMIN_KEY，恒 404+403）。 */
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
  const o = await pool.query(`SELECT amount FROM gq_order WHERE out_trade_no = $1`, [no]);
  const amount = o.rows[0]?.amount as number | undefined;
  if (amount === undefined) return c.json({ code: 404, msg: "order not found" }, 404);
  const r = await settlePayment(pool, no, "mock", amount);
  return c.json({ code: r.paid ? 0 : 500, msg: r.msg, delivered: r.delivered }, r.paid ? 200 : 500);
});
