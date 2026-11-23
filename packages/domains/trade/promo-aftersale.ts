/**
 * M2 收尾：批量优惠 + 售后。
 * 批量优惠规则（gq_discount，goods+sku 维度，type 语义见下）：
 *   type=1 数量达到门槛 → 整单立减 amount 元
 *   type=2 数量达到门槛 → 每件立减 amount 元
 *   type=3 数量达到门槛 → 折扣（amount=折扣百分数，90 表示 9 折）
 *   下单时取对买家最优的一条规则应用。
 * 售后：用户对已支付订单创建售后单（reason/contact），站内沟通（aftersale_chat），
 *   状态机：0 待处理 → 1 处理中 → 2 已完成（退款/补发等由后台备注说明）。
 */
import { Hono } from "hono";

import type { AppEnv } from "@gqshop/kernel";
import { adminPermGuard, requireAuth, bus } from "@gqshop/kernel";

export const discountRoutes = new Hono<AppEnv>();

/** 后台设置/更新批量优惠规则（同商品+sku+quantity+type 覆盖）。 */
discountRoutes.post("/v1/admin/discount", async (c) => {
  const denied = await adminPermGuard(c, "goods.manage");
  if (denied) return denied;
  const pool = c.get("pool");
  const body = (await c.req.json().catch(() => null)) as
    | { goods_id?: number; sku?: string; quantity?: number; amount?: number; type?: number }
    | null;
  const goodsId = Number(body?.goods_id);
  const sku = String(body?.sku ?? "0").slice(0, 100);
  const quantity = Math.max(2, Math.round(Number(body?.quantity ?? 2)));
  const amount = Number(body?.amount ?? 0);
  const type = Math.round(Number(body?.type ?? 1));
  if (!goodsId || amount <= 0 || ![1, 2, 3].includes(type)) {
    return c.json({ code: 400, msg: "goods_id/amount(>0)/type(1|2|3) required" }, 400);
  }
  if (type === 3 && (amount <= 0 || amount >= 100)) {
    return c.json({ code: 400, msg: "type=3 discount percent must be 1-99" }, 400);
  }
  await pool.query(`DELETE FROM gq_discount WHERE goods_id = $1 AND sku = $2 AND quantity = $3 AND type = $4`, [
    goodsId,
    sku,
    quantity,
    type,
  ]);
  await pool.query(
    `INSERT INTO gq_discount (goods_id, sku, quantity, amount, type) VALUES ($1, $2, $3, $4, $5)`,
    [goodsId, sku, quantity, amount.toFixed(2), type],
  );
  return c.json({ code: 0, data: { goods_id: goodsId, sku, quantity, amount, type } }, 201);
});

/** 后台：查询某商品的批量优惠规则。 */
discountRoutes.get("/v1/admin/discount", async (c) => {
  const denied = await adminPermGuard(c, "goods.manage");
  if (denied) return denied;
  const goodsId = Number(c.req.query("goods_id"));
  if (!goodsId) return c.json({ code: 400, msg: "goods_id required" }, 400);
  const pool = c.get("pool");
  const res = await pool.query(
    `SELECT id, sku, quantity, amount, type FROM gq_discount WHERE goods_id = $1 ORDER BY quantity ASC, type ASC`,
    [goodsId],
  );
  return c.json({ code: 0, data: res.rows });
});

/** 后台：删除一条规则。 */
discountRoutes.delete("/v1/admin/discount/:id", async (c) => {
  const denied = await adminPermGuard(c, "goods.manage");
  if (denied) return denied;
  const pool = c.get("pool");
  await pool.query(`DELETE FROM gq_discount WHERE id = $1`, [Number(c.req.param("id"))]);
  return c.json({ code: 0, msg: "deleted" });
});

/** 下单优惠计算（纯函数，供 orders.ts 与单测使用）。 */
export function applyBestDiscount(
  rules: Array<{ quantity: number; amount: string; type: number }>,
  quantity: number,
  unitCents: number,
): { discountCents: number; rule: { quantity: number; amount: string; type: number } | null } {
  let best = { discountCents: 0, rule: null as null | (typeof rules)[number] };
  for (const r of rules) {
    if (quantity < r.quantity) continue;
    const amt = Number(r.amount);
    let d = 0;
    if (r.type === 1) d = Math.round(amt * 100); // 整单立减
    else if (r.type === 2) d = Math.round(amt * 100) * quantity; // 每件立减
    else if (r.type === 3) d = Math.max(0, unitCents * quantity - Math.round((unitCents * quantity * amt) / 100)); // 折扣
    if (d > best.discountCents) best = { discountCents: d, rule: r };
  }
  return best;
}

export const aftersaleRoutes = new Hono<AppEnv>();

/** 用户创建售后单（对本人已支付订单）。 */
aftersaleRoutes.post("/v1/user/aftersale", requireAuth(), async (c) => {
  const uid = c.get("uid");
  const pool = c.get("pool");
  const body = (await c.req.json().catch(() => null)) as
    | { out_trade_no?: string; type?: string; reason?: string; contact?: string }
    | null;
  const no = String(body?.out_trade_no ?? "").slice(0, 64);
  const type = ["refund", "resend", "other"].includes(String(body?.type)) ? String(body?.type) : "other";
  const reason = String(body?.reason ?? "").slice(0, 1000);
  const contact = String(body?.contact ?? "").slice(0, 255);
  if (!no || !reason) return c.json({ code: 400, msg: "out_trade_no and reason required" }, 400);

  const o = await pool.query(
    `SELECT id, status FROM gq_order WHERE out_trade_no = $1 AND user_id = $2 AND delete_time IS NULL`,
    [no, uid],
  );
  const order = o.rows[0] as { id: number; status: number } | undefined;
  if (!order) return c.json({ code: 404, msg: "order not found" }, 404);
  if (order.status !== 2) return c.json({ code: 409, msg: "order not delivered yet" }, 409);

  const items = await pool.query<{ id: number; goods_title: string | null }>(
    `SELECT ol.id, g.title AS goods_title FROM gq_order_list ol
     LEFT JOIN gq_goods g ON g.id = ol.goods_id WHERE ol.order_id = $1 LIMIT 1`,
    [order.id],
  );
  const a = await pool.query(
    `INSERT INTO gq_aftersale (order_id, order_list_id, out_trade_no, goods_title, type, reason, contact, status, create_time)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 0, $8) RETURNING id`,
    [order.id, items.rows[0]?.id ?? 0, no, items.rows[0]?.goods_title ?? "", type, reason, contact, Math.floor(Date.now() / 1000)],
  );
  const aftersaleId = a.rows[0].id as number;
  await pool.query(
    `INSERT INTO gq_aftersale_chat (aftersale_id, order_id, order_list_id, out_trade_no, sender_type, content, create_time)
     VALUES ($1, $2, $3, $4, 'user', $5, $6)`,
    [aftersaleId, order.id, items.rows[0]?.id ?? 0, no, reason, Math.floor(Date.now() / 1000)],
  );
  // v1.2.0：售后创建事件（插件通知：邮件/webhook）
  await bus.emit("aftersale:created", { aftersaleId, orderId: order.id });
  return c.json({ code: 0, msg: "submitted", data: { aftersale_id: aftersaleId } }, 201);
});

/** 我的售后单。 */
aftersaleRoutes.get("/v1/user/aftersale", requireAuth(), async (c) => {
  const uid = c.get("uid");
  const pool = c.get("pool");
  const res = await pool.query(
    `SELECT a.id, a.out_trade_no, a.goods_title, a.type, a.reason, a.status, a.create_time
     FROM gq_aftersale a
     JOIN gq_order o ON o.id = a.order_id
     WHERE o.user_id = $1 ORDER BY a.id DESC LIMIT 50`,
    [uid],
  );
  return c.json({ code: 0, data: res.rows });
});

/** 后台：售后列表 / 回复 / 结单。 */
aftersaleRoutes.get("/v1/admin/aftersale", async (c) => {
  const denied = await adminPermGuard(c, "aftersale.manage");
  if (denied) return denied;
  const pool = c.get("pool");
  const res = await pool.query(
    `SELECT id, out_trade_no, goods_title, type, reason, contact, status, create_time
     FROM gq_aftersale ORDER BY id DESC LIMIT 100`,
  );
  return c.json({ code: 0, data: res.rows });
});

aftersaleRoutes.post("/v1/admin/aftersale/:id/reply", async (c) => {
  const denied = await adminPermGuard(c, "aftersale.manage");
  if (denied) return denied;
  const pool = c.get("pool");
  const id = Number(c.req.param("id"));
  const body = (await c.req.json().catch(() => null)) as { content?: string; resolve?: boolean } | null;
  const content = String(body?.content ?? "").slice(0, 1000);
  if (!content) return c.json({ code: 400, msg: "content required" }, 400);
  const a = await pool.query(`SELECT id, order_id, order_list_id, out_trade_no, type, status FROM gq_aftersale WHERE id = $1`, [id]);
  const row = a.rows[0] as { id: number; order_id: number; order_list_id: number; out_trade_no: string; type: string; status: number } | undefined;
  if (!row) return c.json({ code: 404, msg: "not found" }, 404);
  await pool.query(
    `INSERT INTO gq_aftersale_chat (aftersale_id, order_id, order_list_id, out_trade_no, sender_type, content, create_time)
     VALUES ($1, $2, $3, $4, 'admin', $5, $6)`,
    [id, row.order_id, row.order_list_id, row.out_trade_no, content, Math.floor(Date.now() / 1000)],
  );
  if (body?.resolve) {
    await pool.query(
      `UPDATE gq_aftersale SET status = 2, handle_time = $2 WHERE id = $1`,
      [id, Math.floor(Date.now() / 1000)],
    );
    // M7 C1（deductOrder 等价）+ R2-β 事件化：退款结单 → members 域订阅反扣（独立事务）
    if (row.type === "refund") {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await bus.emit("aftersale:refunded", { orderNo: row.out_trade_no, executor: client as never });
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        console.error("[aftersale] refund deduct failed:", err);
      } finally {
        client.release();
      }
    }
  } else if (row.status === 0) {
    await pool.query(`UPDATE gq_aftersale SET status = 1 WHERE id = $1`, [id]);
  }
  return c.json({ code: 0, msg: "replied" });
});

aftersaleRoutes.get("/v1/admin/aftersale/:id/chat", async (c) => {
  const denied = await adminPermGuard(c, "aftersale.manage");
  if (denied) return denied;
  const pool = c.get("pool");
  const id = Number(c.req.param("id"));
  const res = await pool.query(
    `SELECT sender_type, content, create_time FROM gq_aftersale_chat WHERE aftersale_id = $1 ORDER BY id ASC`,
    [id],
  );
  return c.json({ code: 0, data: res.rows });
});
