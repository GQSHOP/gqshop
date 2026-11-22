/**
 * M3 实物商品（ADR-005）：
 *   GET/PUT    /v1/user/address        — 地址簿（唯一 uid 一址）
 *   GET/POST/PATCH/DELETE /v1/admin/shipping-templates — 运费模板 CRUD
 *   POST       /v1/admin/goods/[id]/shipping — 商品绑定运费模板
 *   GET        /v1/admin/physical/sales — 发货单列表
 *   POST       /v1/admin/physical/sales/[id]/ship — 填物流发货
 */
import { eq } from "drizzle-orm";
import { Hono } from "hono";

import { physicalShippingTemplateTable } from "@gqshop/db";
import type { AppEnv } from "./index.js";
import { adminPermGuard } from "./lib/admin-auth.js";
import { requireAuth } from "./lib/jwt.js";

export const physicalRoutes = new Hono<AppEnv>();

// ============ 用户地址簿（dc_physical_address 唯一 uid 一址） ============

/** 保存收货地址（每 uid 一址，upsert）。 */
physicalRoutes.post("/v1/user/address", requireAuth(), async (c) => {
  const uid = c.get("uid");
  const pool = c.get("pool");
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  const receiverName = String(body?.receiver_name ?? "").slice(0, 50);
  const receiverPhone = String(body?.receiver_phone ?? "").slice(0, 20);
  const region = String(body?.region ?? "").slice(0, 120);
  const address = String(body?.address ?? "").slice(0, 200);
  const buyerRemark = String(body?.buyer_remark ?? "").slice(0, 100);
  if (!receiverName || !receiverPhone || !region || !address) {
    return c.json({ code: 400, msg: "receiver_name/phone/region/address required" }, 400);
  }
  const existing = await pool.query(`SELECT id FROM dc_physical_address WHERE uid = $1`, [uid]);
  if (existing.rows[0]) {
    await pool.query(
      `UPDATE dc_physical_address SET receiver_name = $1, receiver_phone = $2, region = $3,
              address = $4, buyer_remark = $5, update_time = $6 WHERE uid = $7`,
      [receiverName, receiverPhone, region, address, buyerRemark, Date.now(), uid],
    );
  } else {
    await pool.query(
      `INSERT INTO dc_physical_address (uid, receiver_name, receiver_phone, region, address, buyer_remark, create_time)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [uid, receiverName, receiverPhone, region, address, buyerRemark, Date.now()],
    );
  }
  return c.json({ code: 0, msg: "saved" });
});

physicalRoutes.get("/v1/user/address", requireAuth(), async (c) => {
  const pool = c.get("pool");
  const r = await pool.query(
    `SELECT id, receiver_name, receiver_phone, region, address, buyer_remark FROM dc_physical_address WHERE uid = $1`,
    [c.get("uid")],
  );
  return c.json({ code: 0, data: r.rows[0] ?? null });
});

physicalRoutes.put("/v1/user/address", requireAuth(), async (c) => {
  const uid = c.get("uid");
  const pool = c.get("pool");
  const body = (await c.req.json().catch(() => null)) as
    | { receiver_name?: string; receiver_phone?: string; region?: string; address?: string; buyer_remark?: string }
    | null;
  const name = (body?.receiver_name ?? "").trim().slice(0, 100);
  const phone = (body?.receiver_phone ?? "").trim().slice(0, 50);
  const region = (body?.region ?? "").trim().slice(0, 255);
  const address = (body?.address ?? "").trim().slice(0, 500);
  const remark = (body?.buyer_remark ?? "").trim().slice(0, 500);
  if (!name || !phone || !region || !address) {
    return c.json({ code: 400, msg: "receiver_name/phone/region/address required" }, 400);
  }
  const now = Date.now();
  await pool.query(
    `INSERT INTO dc_physical_address (uid, receiver_name, receiver_phone, region, address, buyer_remark, create_time, update_time)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
     ON CONFLICT (uid) DO UPDATE SET receiver_name = $2, receiver_phone = $3, region = $4,
       address = $5, buyer_remark = $6, update_time = $7`,
    [uid, name, phone, region, address, remark, now],
  );
  return c.json({ code: 0, msg: "ok" });
});

// ============ 运费计算（导出供 orders.ts） ============

export interface ShippingQuote {
  templateId: number;
  feeCents: number;
}

/** 商品绑定的运费报价（分）。无模板或停用返回 null（免运费兜底）。 */
export async function quoteShipping(
  pool: import("pg").Pool,
  goodsId: number,
  qty: number,
  subtotalCents: number,
): Promise<ShippingQuote | null> {
  const r = await pool.query<{ id: number; first_fee: number; append_fee: number; free_threshold: number }>(
    `SELECT t.id, t.first_fee, t.append_fee, t.free_threshold
     FROM dc_physical_goods_shipping gs
     JOIN dc_physical_shipping_template t ON t.id = gs.template_id AND t.status = 1 AND t.delete_time IS NULL
     WHERE gs.goods_id = $1 LIMIT 1`,
    [goodsId],
  );
  const t = r.rows[0];
  if (!t) return null;
  const free = Number(t.free_threshold) > 0 && subtotalCents >= Number(t.free_threshold);
  if (free) return { templateId: t.id, feeCents: 0 };
  const fee = Number(t.first_fee) + Math.max(0, qty - 1) * Number(t.append_fee);
  return { templateId: t.id, feeCents: fee };
}

/** 支付成功后建发货单（settlePayment 内联调用；幂等：uniq order_list_id）。 */
export async function createPhysicalSale(
  client: import("pg").PoolClient,
  orderId: number,
): Promise<void> {
  const items = await client.query<{ id: number; goods_id: number | null; sku: string | null; quantity: number | null }>(
    `SELECT ol.id, ol.goods_id, ol.sku, ol.quantity
     FROM dc_order_list ol LEFT JOIN dc_goods g ON g.id = ol.goods_id
     WHERE ol.order_id = $1 AND g.type = 'goods_physical'`,
    [orderId],
  );
  if (items.rows.length === 0) return;
  const addr = await client.query<{ receiver_name: string; receiver_phone: string; region: string; address: string; buyer_remark: string }>(
    `SELECT a.receiver_name, a.receiver_phone, a.region, a.address, a.buyer_remark
     FROM dc_physical_address a JOIN dc_order o ON o.user_id = a.uid WHERE o.id = $1`,
    [orderId],
  );
  const ad = addr.rows[0];
  if (!ad) {
    console.error("[physical] address missing for sale record, order", orderId);
    return;
  }
  for (const it of items.rows) {
    await client.query(
      `INSERT INTO dc_physical_sale (goods_id, order_list_id, sku, num,
                                     receiver_name, receiver_phone, region, address, buyer_remark,
                                     logistics_company, logistics_no, status, create_time, update_time)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, '', '', 0, $10, $10)
       ON CONFLICT (order_list_id) DO NOTHING`,
      [it.goods_id ?? 0, it.id, it.sku ?? "0", Math.max(1, it.quantity ?? 1),
        ad.receiver_name, ad.receiver_phone, ad.region, ad.address, ad.buyer_remark, Date.now()],
    );
  }
}

// ============ admin：运费模板 CRUD（drizzle 参数化 setter） ============

physicalRoutes.get("/v1/admin/shipping-templates", async (c) => {
  const denied = await adminPermGuard(c, "physical.manage");
  if (denied) return denied;
  const pool = c.get("pool");
  const r = await pool.query(
    `SELECT id, name, first_fee, append_fee, free_threshold, status, description
     FROM dc_physical_shipping_template WHERE delete_time IS NULL ORDER BY id DESC`,
  );
  return c.json({ code: 0, data: r.rows });
});

physicalRoutes.post("/v1/admin/shipping-templates", async (c) => {
  const denied = await adminPermGuard(c, "physical.manage");
  if (denied) return denied;
  const db = c.get("db");
  const body = (await c.req.json().catch(() => null)) as
    | { name?: string; first_fee?: number; append_fee?: number; free_threshold?: number; description?: string }
    | null;
  const name = (body?.name ?? "").trim().slice(0, 100);
  if (!name) return c.json({ code: 400, msg: "name required" }, 400);
  const now = Date.now();
  const ins = await db.insert(physicalShippingTemplateTable).values({
    name,
    first_fee: Math.max(0, Math.round(Number(body?.first_fee ?? 0))),
    append_fee: Math.max(0, Math.round(Number(body?.append_fee ?? 0))),
    free_threshold: Math.max(0, Math.round(Number(body?.free_threshold ?? 0))),
    status: 1,
    description: (body?.description ?? "").slice(0, 500),
    create_time: now,
    update_time: now,
  }).returning({ id: physicalShippingTemplateTable.id });
  return c.json({ code: 0, data: { id: ins[0]?.id } }, 201);
});

physicalRoutes.patch("/v1/admin/shipping-templates/:id", async (c) => {
  const denied = await adminPermGuard(c, "physical.manage");
  if (denied) return denied;
  const db = c.get("db");
  const id = Number(c.req.param("id"));
  const body = (await c.req.json().catch(() => null)) as
    | { name?: string; first_fee?: number; append_fee?: number; free_threshold?: number; status?: number; description?: string }
    | null;
  const sets: Partial<typeof physicalShippingTemplateTable.$inferInsert> = { update_time: Date.now() };
  if (typeof body?.name === "string" && body.name.trim()) sets.name = body.name.trim().slice(0, 100);
  if (body?.first_fee !== undefined) sets.first_fee = Math.max(0, Math.round(Number(body.first_fee)));
  if (body?.append_fee !== undefined) sets.append_fee = Math.max(0, Math.round(Number(body.append_fee)));
  if (body?.free_threshold !== undefined) sets.free_threshold = Math.max(0, Math.round(Number(body.free_threshold)));
  if (body?.status !== undefined) sets.status = body.status === 0 ? 0 : 1;
  if (typeof body?.description === "string") sets.description = body.description.slice(0, 500);
  await db.update(physicalShippingTemplateTable).set(sets).where(eq(physicalShippingTemplateTable.id, id));
  return c.json({ code: 0, msg: "ok" });
});

physicalRoutes.delete("/v1/admin/shipping-templates/:id", async (c) => {
  const denied = await adminPermGuard(c, "physical.manage");
  if (denied) return denied;
  const db = c.get("db");
  await db.update(physicalShippingTemplateTable)
    .set({ delete_time: Date.now() })
    .where(eq(physicalShippingTemplateTable.id, Number(c.req.param("id"))));
  return c.json({ code: 0, msg: "deleted" });
});

/** 商品绑定运费模板。 */
physicalRoutes.post("/v1/admin/goods/:id/shipping", async (c) => {
  const denied = await adminPermGuard(c, "physical.manage");
  if (denied) return denied;
  const pool = c.get("pool");
  const goodsId = Number(c.req.param("id"));
  const body = (await c.req.json().catch(() => null)) as { template_id?: number } | null;
  const templateId = Number(body?.template_id);
  if (!goodsId || !templateId) return c.json({ code: 400, msg: "template_id required" }, 400);
  const now = Date.now();
  await pool.query(
    `INSERT INTO dc_physical_goods_shipping (goods_id, template_id, create_time, update_time)
     VALUES ($1, $2, $3, $3)
     ON CONFLICT (goods_id) DO UPDATE SET template_id = $2, update_time = $3`,
    [goodsId, templateId, now],
  );
  return c.json({ code: 0, msg: "ok" });
});

// ============ 发货单 ============

/** status 查询参数 → 0/1/null 白名单。 */
function statusFilterOf(raw: string | undefined): number | null {
  return raw === "0" || raw === "1" ? Number(raw) : null;
}

physicalRoutes.get("/v1/admin/physical/sales", async (c) => {
  const denied = await adminPermGuard(c, "order.ship");
  if (denied) return denied;
  const pool = c.get("pool");
  const statusFilter = statusFilterOf(c.req.query("status"));
  const r = await pool.query(
    `SELECT s.id, s.goods_id, g.title AS goods_title, s.order_list_id, s.sku, s.num,
            s.receiver_name, s.receiver_phone, s.region, s.address, s.buyer_remark,
            s.logistics_company, s.logistics_no, s.status, s.create_time, s.deliver_time,
            ol.order_id, o.out_trade_no, o.user_id
     FROM dc_physical_sale s
     LEFT JOIN dc_goods g ON g.id = s.goods_id
     LEFT JOIN dc_order_list ol ON ol.id = s.order_list_id
     LEFT JOIN dc_order o ON o.id = ol.order_id
     WHERE ($1::int IS NULL OR s.status = $1::int)
     ORDER BY s.id DESC LIMIT 100`,
    [statusFilter],
  );
  return c.json({ code: 0, data: r.rows });
});

physicalRoutes.post("/v1/admin/physical/sales/:id/ship", async (c) => {
  const denied = await adminPermGuard(c, "order.ship");
  if (denied) return denied;
  const pool = c.get("pool");
  const id = Number(c.req.param("id"));
  const body = (await c.req.json().catch(() => null)) as { logistics_company?: string; logistics_no?: string; remark?: string } | null;
  const company = (body?.logistics_company ?? "").trim().slice(0, 100);
  const no = (body?.logistics_no ?? "").trim().slice(0, 100);
  if (!company || !no) return c.json({ code: 400, msg: "logistics_company/no required" }, 400);
  const now = Date.now();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const r = await client.query<{ order_list_id: number; status: number }>(
      `UPDATE dc_physical_sale SET logistics_company = $2, logistics_no = $3, deliver_remark = $4,
              status = 1, deliver_time = $5, update_time = $5
       WHERE id = $1 AND status = 0 RETURNING order_list_id, status`,
      [id, company, no, (body?.remark ?? "").slice(0, 1000), now],
    );
    const row = r.rows[0];
    if (!row) {
      await client.query("ROLLBACK");
      return c.json({ code: 409, msg: "sale not pending or not found" }, 409);
    }
    await client.query(`UPDATE dc_order_list SET status = 2 WHERE id = $1`, [row.order_list_id]);
    const ol = await client.query<{ order_id: number }>(
      `SELECT order_id FROM dc_order_list WHERE id = $1`, [row.order_list_id],
    );
    const orderId = ol.rows[0]?.order_id;
    if (orderId) {
      const pending = await client.query(
        `SELECT COUNT(*)::int AS n FROM dc_order_list WHERE order_id = $1 AND status <> 2`,
        [orderId],
      );
      if (pending.rows[0].n === 0) {
        await client.query(`UPDATE dc_order SET status = 2, update_time = $2 WHERE id = $1`, [orderId, now]);
      }
    }
    await client.query("COMMIT");
    return c.json({ code: 0, msg: "shipped" });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    return c.json({ code: 500, msg: String(err).slice(0, 200) }, 500);
  } finally {
    client.release();
  }
});

/** 店面运费预估（公开；仅按商品绑定模板计算，不含地址因素）。 */
physicalRoutes.get("/v1/shop/goods/:id/shipping-quote", async (c) => {
  const pool = c.get("pool");
  const goodsId = Number(c.req.param("id"));
  const quantity = Math.max(1, Number(c.req.query("quantity") ?? 1));
  const subtotalCents = Math.max(0, Number(c.req.query("subtotal") ?? 0));
  if (!goodsId) return c.json({ code: 400, msg: "goods id required" }, 400);
  const quote = await quoteShipping(pool, goodsId, quantity, subtotalCents);
  return c.json({ code: 0, data: { fee_cents: quote?.feeCents ?? 0, free: quote ? quote.feeCents === 0 : false, has_template: !!quote } });
});
