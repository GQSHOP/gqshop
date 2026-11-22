/**
 * M1 后台：商品创建/SKU/卡密导入/订单查看（X-Admin-Key 过渡鉴权）。
 * 价格单位：分（integer，上游语义）。
 */
import { Hono } from "hono";

import { adminPermGuard } from "@gqshop/kernel";
import type { AppEnv } from "@gqshop/kernel";

export const adminTradeRoutes = new Hono<AppEnv>();

adminTradeRoutes.post("/v1/admin/goods", async (c) => {
  const denied = await adminPermGuard(c, "goods.manage");
  if (denied) return denied;
  const pool = c.get("pool");
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return c.json({ code: 400, msg: "invalid json body" }, 400);

  const title = typeof body.title === "string" ? body.title.slice(0, 150) : "";
  const type = typeof body.type === "string" ? body.type : "goods_general";
  const guestPrice = Math.max(0, Math.round(Number(body.guest_price ?? 0)));
  const marketPrice = Math.max(0, Math.round(Number(body.market_price ?? 0)));
  const sortId = Math.round(Number(body.sort_id ?? 0));
  const content = typeof body.content === "string" ? body.content.slice(0, 20000) : "";
  if (!title || guestPrice <= 0) {
    return c.json({ code: 400, msg: "title and guest_price(>0, in cents) required" }, 400);
  }
  if (!["goods_once", "goods_general", "goods_service", "goods_physical"].includes(type)) {
    return c.json({ code: 400, msg: "type must be goods_once/goods_general/goods_service/goods_physical" }, 400);
  }

  const r = await pool.query(
    `INSERT INTO gq_goods (title, type, is_sku, content, sort_id, is_on_shelf, create_time, station_id)
     VALUES ($1, $2, 'n', $3, $4, 1, $5, 0)
     RETURNING id`,
    [title, type, content, sortId, Date.now()],
  );
  const goodsId = r.rows[0].id as number;

  // 上游语义：单规格商品对应一条 sku='0' 默认 SKU 行
  await pool.query(
    `INSERT INTO gq_skus (goods_id, sku, market_price, guest_price, stock, sales)
     VALUES ($1, '0', $2, $3, 0, 0)`,
    [goodsId, marketPrice, guestPrice],
  );
  return c.json({ code: 0, data: { goods_id: goodsId } }, 201);
});

adminTradeRoutes.post("/v1/admin/goods/:id/skus", async (c) => {
  const denied = await adminPermGuard(c, "goods.manage");
  if (denied) return denied;
  const pool = c.get("pool");
  const goodsId = Number(c.req.param("id"));
  const body = (await c.req.json().catch(() => null)) as Array<Record<string, unknown>> | null;
  if (!body || !Array.isArray(body) || body.length === 0) {
    return c.json({ code: 400, msg: "skus array required" }, 400);
  }
  await pool.query(`UPDATE gq_goods SET is_sku = 'y' WHERE id = $1`, [goodsId]);
  for (const s of body) {
    const code = String(s.code ?? "").slice(0, 50);
    const sku = String(s.sku ?? "").slice(0, 255);
    const guest = Math.max(0, Math.round(Number(s.guest_price ?? 0)));
    const market = Math.max(0, Math.round(Number(s.market_price ?? 0)));
    if (!sku || guest <= 0) continue;
    await pool.query(
      `INSERT INTO gq_skus (goods_id, code, sku, market_price, guest_price, stock, sales)
       VALUES ($1, $2, $3, $4, $5, 0, 0)`,
      [goodsId, code, sku, market, guest],
    );
  }
  return c.json({ code: 0, msg: "ok" }, 201);
});

adminTradeRoutes.post("/v1/admin/stock/import", async (c) => {
  const denied = await adminPermGuard(c, "stock.manage");
  if (denied) return denied;
  const pool = c.get("pool");
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return c.json({ code: 400, msg: "invalid json body" }, 400);
  const goodsId = Number(body.goods_id);
  const sku = String(body.sku ?? "0").slice(0, 50);
  const cards = Array.isArray(body.cards) ? body.cards.map(String) : [];
  if (!goodsId || cards.length === 0) {
    return c.json({ code: 400, msg: "goods_id and cards[] required" }, 400);
  }
  const g = await pool.query(`SELECT type FROM gq_goods WHERE id = $1`, [goodsId]);
  const type = g.rows[0]?.type as string | undefined;
  if (!type) return c.json({ code: 404, msg: "goods not found" }, 404);
  const now = Date.now();
  let added = 0;

  if (type === "goods_once") {
    for (const card of cards.slice(0, 5000)) {
      await pool.query(
        `INSERT INTO gq_goods_once (goods_id, sku, content, create_time, update_time, order_list_id)
         VALUES ($1, $2, $3, $4, $5, 0)`,
        [goodsId, sku, card.slice(0, 2000), now, now],
      );
      added++;
    }
  } else if (type === "goods_general") {
    for (const card of cards.slice(0, 5000)) {
      await pool.query(
        `INSERT INTO gq_goods_general (goods_id, sku, content, create_time, update_time)
         VALUES ($1, $2, $3, $4, $5)`,
        [goodsId, sku, card.slice(0, 2000), now, now],
      );
      added++;
    }
  } else if (type === "goods_service") {
    // 服务型：每个内容一条 gq_goods_service 记录
    for (const card of cards.slice(0, 5000)) {
      await pool.query(
        `INSERT INTO gq_goods_service (goods_id, sku, content, create_time, update_time)
         VALUES ($1, $2, $3, $4, $5)`,
        [goodsId, sku, card.slice(0, 255), now, now],
      );
      added++;
    }
  } else if (type === "goods_physical") {
    // 实物：无卡密行，直接加库存（每行视为一件）
    added = cards.length;
  } else {
    return c.json({ code: 400, msg: "unsupported goods type" }, 400);
  }

  await pool.query(`UPDATE gq_goods SET stock = stock + $1 WHERE id = $2`, [added, goodsId]);
  await pool.query(`UPDATE gq_skus SET stock = stock + $1 WHERE goods_id = $2 AND sku = $3`, [
    added,
    goodsId,
    sku,
  ]);
  return c.json({ code: 0, data: { added, type } }, 201);
});

adminTradeRoutes.get("/v1/admin/orders", async (c) => {
  const denied = await adminPermGuard(c, "order.view");
  if (denied) return denied;
  const pool = c.get("pool");
  const page = Math.max(1, Number(c.req.query("page") ?? 1));
  const limit = Math.min(100, Math.max(1, Number(c.req.query("limit") ?? 20)));
  const res = await pool.query(
    `SELECT o.id, o.out_trade_no, o.amount, o.pay_status, o.status, o.payment, o.create_time,
            o.tel, o.email, u.username
     FROM gq_order o LEFT JOIN gq_user u ON u.uid = o.user_id
     WHERE o.delete_time IS NULL
     ORDER BY o.id DESC LIMIT $1 OFFSET $2`,
    [limit, (page - 1) * limit],
  );
  return c.json({ code: 0, data: { list: res.rows, page, limit } });
});

/** 仪表盘统计（adm_home 语义：今日订单/销售额/商品/库存预警）。 */
adminTradeRoutes.get("/v1/admin/stats", async (c) => {
  const denied = await adminPermGuard(c, "dashboard.view");
  if (denied) return denied;
  const pool = c.get("pool");
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const ts = todayStart.getTime();

  const orders = await pool.query(
    `SELECT COUNT(*)::int AS cnt, COALESCE(SUM(amount),0)::int AS sales
     FROM gq_order WHERE pay_status = 1 AND pay_time >= $1 AND delete_time IS NULL`,
    [ts],
  );
  const goodsAgg = await pool.query(
    `SELECT COUNT(*)::int AS goods_count, COALESCE(SUM(stock),0)::int AS stock_total
     FROM gq_goods WHERE delete_time IS NULL AND station_id = 0`,
  );
  const lowStock = await pool.query(
    `SELECT id, title, stock, type FROM gq_goods
     WHERE delete_time IS NULL AND station_id = 0 AND is_on_shelf = 1 AND stock <= 5
     ORDER BY stock ASC LIMIT 10`,
  );
  const users = await pool.query(`SELECT COUNT(*)::int AS cnt FROM gq_user`);
  return c.json({
    code: 0,
    data: {
      today_orders: orders.rows[0].cnt,
      today_sales: orders.rows[0].sales,
      goods_count: goodsAgg.rows[0].goods_count,
      stock_total: goodsAgg.rows[0].stock_total,
      user_count: users.rows[0].cnt,
      low_stock: lowStock.rows,
    },
  });
});

/** 商品列表（后台管理视角，含下架商品）。 */
adminTradeRoutes.get("/v1/admin/goods", async (c) => {
  const denied = await adminPermGuard(c, "goods.manage");
  if (denied) return denied;
  const pool = c.get("pool");
  const page = Math.max(1, Number(c.req.query("page") ?? 1));
  const limit = Math.min(50, Math.max(1, Number(c.req.query("limit") ?? 20)));
  const kw = (c.req.query("keyword") ?? "").slice(0, 50);
  const res = await pool.query(
    `SELECT g.id, g.title, g.type, g.is_sku, g.is_on_shelf, g.stock, g.sales, g.create_time,
            MIN(COALESCE(s.guest_price, s.market_price)) AS min_price
     FROM gq_goods g LEFT JOIN gq_skus s ON s.goods_id = g.id
     WHERE g.delete_time IS NULL AND g.station_id = 0
       AND ($1::varchar = '' OR g.title LIKE '%' || $1::varchar || '%')
     GROUP BY g.id
     ORDER BY g.id DESC LIMIT $2 OFFSET $3`,
    [kw, limit, (page - 1) * limit],
  );
  return c.json({ code: 0, data: { list: res.rows, page, limit } });
});

/** 上下架切换。 */
adminTradeRoutes.patch("/v1/admin/goods/:id/shelf", async (c) => {
  const denied = await adminPermGuard(c, "goods.manage");
  if (denied) return denied;
  const pool = c.get("pool");
  const id = Number(c.req.param("id"));
  const body = (await c.req.json().catch(() => null)) as { is_on_shelf?: number } | null;
  const on = body?.is_on_shelf === 0 ? 0 : 1;
  const r = await pool.query(
    `UPDATE gq_goods SET is_on_shelf = $1 WHERE id = $2 AND delete_time IS NULL`,
    [on, id],
  );
  if (r.rowCount !== 1) return c.json({ code: 404, msg: "goods not found" }, 404);
  return c.json({ code: 0, msg: on === 1 ? "已上架" : "已下架" });
});

/** 库存明细：指定商品的 SKU 行 + 三类卡池余量。 */
adminTradeRoutes.get("/v1/admin/stock/:goodsId", async (c) => {
  const denied = await adminPermGuard(c, "stock.manage");
  if (denied) return denied;
  const pool = c.get("pool");
  const goodsId = Number(c.req.param("goodsId"));
  const g = await pool.query(
    `SELECT id, title, type, stock FROM gq_goods WHERE id = $1 AND delete_time IS NULL`,
    [goodsId],
  );
  const goods = g.rows[0] as { id: number; title: string; type: string; stock: number } | undefined;
  if (!goods) return c.json({ code: 404, msg: "goods not found" }, 404);

  const skus = await pool.query(
    `SELECT code, sku, market_price, guest_price, stock, sales FROM gq_skus WHERE goods_id = $1`,
    [goodsId],
  );
  const counts = { once_remaining: 0, general_pool: 0, service_rows: 0 };
  if (goods.type === "goods_once") {
    const r = await pool.query(
      `SELECT COUNT(*)::int AS n FROM gq_goods_once WHERE goods_id = $1 AND order_list_id = 0`,
      [goodsId],
    );
    counts.once_remaining = r.rows[0].n;
  } else if (goods.type === "goods_general") {
    const r = await pool.query(
      `SELECT COUNT(*)::int AS n FROM gq_goods_general WHERE goods_id = $1`,
      [goodsId],
    );
    counts.general_pool = r.rows[0].n;
  } else if (goods.type === "goods_service") {
    const r = await pool.query(
      `SELECT COUNT(*)::int AS n FROM gq_goods_service WHERE goods_id = $1`,
      [goodsId],
    );
    counts.service_rows = r.rows[0].n;
  }
  return c.json({ code: 0, data: { goods, skus: skus.rows, counts } });
});
