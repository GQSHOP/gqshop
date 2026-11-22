/**
 * M1 交易域：商品/分类公开读接口。
 * 价格语义（上游设计）：价格全在 SKU 上，单规格商品对应一条 sku='0' 的默认 SKU 行。
 * M3 分店：station 上下文下按 gq_station_goods 映射过滤（显式隐藏/未映射且 master_goods≠1），
 * 携带 premium/custom_name 供前端展示分店价。
 */
import { Hono } from "hono";
import { and, desc, eq, ilike, isNull, min } from "drizzle-orm";

import { goodsTable, skusTable } from "@gqshop/db";
import { requireAuthOptional, getOption } from "@gqshop/kernel";
import type { AppEnv, StationContext } from "@gqshop/kernel";

export const goodsRoutes = new Hono<AppEnv>();

/** M4 收尾：主站公开站点配置（滚动公告/首页公告）——店面公告从假数据接线到 gq_options。 */
goodsRoutes.get("/v1/shop/site-options", async (c) => {
  const db = c.get("db");
  const [rollBulletin, homeBulletin] = await Promise.all([
    getOption(db, "roll_bulletin", ""),
    getOption(db, "home_bulletin", ""),
  ]);
  return c.json({
    code: 0,
    data: { roll_bulletin: rollBulletin, home_bulletin: homeBulletin },
  });
});

interface GoodsRow {
  id: number;
  title: string;
  type: string | null;
  is_sku: string | null;
  cover: string | null;
  sales: number | null;
  stock: number | null;
  unit_name: string | null;
  sort_id: number | null;
}

interface SkuRow {
  code: string | null;
  sku: string;
  market_price: number | null;
  guest_price: number | null;
  stock: number | null;
  sales: number | null;
  post_url: string | null;
}

goodsRoutes.get("/v1/shop/categories", async (c) => {
  const pool = c.get("pool");
  const res = await pool.query(
    `SELECT s.sid, s.sortname, s.alias, s.taxis, s.sorticon, s.description,
            (SELECT COUNT(*)::int FROM gq_goods g
              WHERE g.sort_id = s.sid AND g.is_on_shelf = 1 AND g.delete_time IS NULL) AS count
     FROM gq_sort s
     WHERE s.type = 'goods' AND s.station_id = 0
     ORDER BY s.taxis ASC, s.sid ASC`,
  );
  return c.json({ code: 0, data: res.rows });
});

goodsRoutes.get("/v1/shop/goods", async (c) => {
  const db = c.get("db");
  const pool = c.get("pool");
  const station = c.get("station") as unknown as StationContext | null;
  const sortId = Number(c.req.query("sort_id") ?? 0);
  const page = Math.max(1, Number(c.req.query("page") ?? 1));
  const limit = Math.min(50, Math.max(1, Number(c.req.query("limit") ?? 12)));
  const offset = (page - 1) * limit;
  // M4 收尾：排序工具条（综合/销量/价格/库存）与 header 搜索关键词真正接线（drizzle 全参数化）。
  // 价格排序取宽页（≤200 条）后按 SKU 最低价 JS 排序——价格在 SKU 表跨表，
  // 发卡站商品量级下内存排序足够精确，M5 数据量上来再做 SQL 化。
  const sortKey = String(c.req.query("sort") ?? "default");
  const keyword = String(c.req.query("keyword") ?? c.req.query("q") ?? "").trim().slice(0, 60);

  const conds = [
    eq(goodsTable.station_id, 0),
    eq(goodsTable.is_on_shelf, 1),
    isNull(goodsTable.delete_time),
  ];
  if (sortId > 0) conds.push(eq(goodsTable.sort_id, sortId));
  if (keyword) conds.push(ilike(goodsTable.title, `%${keyword}%`));

  const orderCols =
    sortKey === "sales"
      ? [desc(goodsTable.sales), desc(goodsTable.id)]
      : sortKey === "stock"
        ? [desc(goodsTable.stock), desc(goodsTable.id)]
        : [desc(goodsTable.index_top), desc(goodsTable.sort_top), desc(goodsTable.sales), desc(goodsTable.id)];
  const fetchLimit = sortKey === "price" ? Math.min(200, limit * 10) : limit;

  const rows = await db
    .select({
      id: goodsTable.id, title: goodsTable.title, type: goodsTable.type, is_sku: goodsTable.is_sku,
      cover: goodsTable.cover, sales: goodsTable.sales, stock: goodsTable.stock,
      unit_name: goodsTable.unit_name, sort_id: goodsTable.sort_id,
    })
    .from(goodsTable)
    .where(and(...conds))
    .orderBy(...orderCols)
    .limit(fetchLimit)
    .offset(sortKey === "price" ? 0 : offset);

  let goods = rows as GoodsRow[];
  if (sortKey === "price") {
    const minps = await db
      .select({ goodsId: skusTable.goods_id, minp: min(skusTable.guest_price) })
      .from(skusTable)
      .groupBy(skusTable.goods_id);
    const pm = new Map(minps.map((r) => [r.goodsId, Number(r.minp ?? 0)]));
    goods = [...rows]
      .sort((a, b) => (pm.get(a.id) ?? Infinity) - (pm.get(b.id) ?? Infinity))
      .slice(offset, offset + limit);
  }

  // 分店可见过滤 + premium/custom_name 附加（一次性批量查映射表）
  const maps = new Map<number, { premium: string | null; is_show: string; custom_name: string | null }>();
  if (station && goods.length > 0) {
    const ids = goods.map((g) => g.id);
    const mr = await pool.query(
      `SELECT goods_id, premium, is_show, custom_name FROM gq_station_goods WHERE station_id = $1`,
      [station.id],
    );
    for (const m of mr.rows as Array<{ goods_id: number; premium: string | null; is_show: string; custom_name: string | null }>) {
      maps.set(m.goods_id, m);
    }
  }
  const enriched = await Promise.all(
    (station ? goods.filter((g) => {
      const m = maps.get(g.id);
      if (m?.is_show === "n") return false; // 显式隐藏
      if (!m && station.master_goods !== 1) return false; // 未映射且非全同步
      return true;
    }) : goods).map(async (g) => {
      const r = await pool.query(
        `SELECT MIN(COALESCE(guest_price, market_price)) AS min_price
         FROM gq_skus WHERE goods_id = $1`,
        [g.id],
      );
      const m = maps.get(g.id);
      const minPrice = r.rows[0]?.min_price ?? null;
      // 分店价 = 主站价 × (1 + premium%)（展示层，下单以 orders.ts 计算为准）
      const pct = m?.premium !== null && m?.premium !== undefined ? Number(m.premium) : null;
      const stationPrice = pct && pct > 0 && minPrice !== null
        ? Math.round(Number(minPrice) * (1 + pct / 100))
        : minPrice;
      return {
        ...g,
        title: m?.custom_name || g.title,
        min_price: station ? stationPrice : minPrice,
        station_premium: m?.premium ?? null,
      };
    }),
  );
  return c.json({ code: 0, data: { list: enriched, page, limit, station: station ? { id: station.id, name: station.name, title: station.title, slug: station.slug, logo: station.logo, roll_notice: station.roll_notice, home_notice: station.home_notice } : null } });
});

goodsRoutes.get("/v1/shop/goods/:id", requireAuthOptional(), async (c) => {
  const pool = c.get("pool");
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) {
    return c.json({ code: 400, msg: "bad goods id" }, 400);
  }
  const g = await pool.query(
    `SELECT id, title, type, is_sku, cover, gallery, content, pay_content, sales, stock,
            unit_name, sort_id, password, is_on_shelf, create_time
     FROM gq_goods WHERE id = $1 AND station_id = 0 AND delete_time IS NULL`,
    [id],
  );
  const goods = g.rows[0] as
    | (GoodsRow & {
        gallery: string | null;
        content: string | null;
        pay_content: string | null;
        password: string | null;
        is_on_shelf: number | null;
        create_time: number | null;
      })
    | undefined;
  if (!goods) return c.json({ code: 404, msg: "goods not found" }, 404);
  if (goods.is_on_shelf !== 1) return c.json({ code: 403, msg: "goods off shelf" }, 403);

  // 审查修复 H3：password 只暴露"是否有密码"；pay_content（付费可见内容）仅已支付
  // 该商品的用户可见——防止凭商品 id 直接从 API 拿到密码/付费内容
  const hasPassword = !!goods.password;
  let payContent: string | null = null;
  const uid = c.get("uid") ?? 0;
  if (goods.pay_content && uid > 0) {
    const bought = await pool.query(
      `SELECT 1 FROM gq_order o JOIN gq_order_list ol ON ol.order_id = o.id
       WHERE o.user_id = $1 AND ol.goods_id = $2 AND o.pay_status = 1 LIMIT 1`,
      [uid, id],
    );
    if (bought.rows.length > 0) payContent = goods.pay_content;
  }
  const safeGoods = { ...goods, password: undefined, pay_content: payContent };

  const skus = await pool.query<SkuRow>(
    `SELECT code, sku, market_price, guest_price, stock, sales, post_url
     FROM gq_skus WHERE goods_id = $1 ORDER BY code ASC NULLS LAST`,
    [id],
  );
  // 批量优惠规则（M2）：随详情下发供店面展示"满 X 件优惠"提示
  const discounts = await pool.query(
    `SELECT sku, quantity, amount, type FROM gq_discount WHERE goods_id = $1 ORDER BY quantity ASC`,
    [id],
  );
  return c.json({ code: 0, data: { ...safeGoods, has_password: hasPassword, skus: skus.rows, discounts: discounts.rows } });
});
