/**
 * M1 交易域：下单（幂等 + 库存预留）与订单查询。
 * 状态机见 lib/trade.ts；库存扣减用 A1 原子条件更新。
 */
import { Hono } from "hono";

import type { AppEnv } from "../index.js";
import { requireAuthOptional } from "../lib/jwt.js";
import { isValidPayPlugin, listPayPlugins } from "../lib/plugin-host.js";
import { applyBestDiscount } from "../m2-final.js";
import { quoteShipping } from "../physical.js";
import { calcTotalCents, genOutTradeNo, unitPriceCents } from "../lib/trade.js";
import type { StationContext } from "../station.js";

export const ordersRoutes = new Hono<AppEnv>();

/** 分店价格链末环（D5）：premium 百分比加价，下限 0（禁倒贴）。 */
export function applyStationPremium(totalCents: number, premiumPct: number | null): number {
  if (premiumPct === null || premiumPct <= 0) return totalCents;
  return Math.max(0, Math.round(totalCents * (1 + premiumPct / 100)));
}

interface CreateBody {
  goods_id?: number;
  station_slug?: string;
  sku_code?: string;
  quantity?: number;
  tel?: string;
  email?: string;
  pay_plugin?: string;
  idempotency_key?: string;
}

/** 支付方式清单（公开；注册表驱动，店面下拉用）。 */
ordersRoutes.get("/v1/shop/pay-methods", async (c) => {
  return c.json({ code: 0, data: { list: listPayPlugins().map((p) => ({ name: p.name, label: p.label, kind: p.kind })) } });
});

ordersRoutes.post("/v1/shop/orders", requireAuthOptional(), async (c) => {
  const pool = c.get("pool");
  const body = (await c.req.json().catch(() => null)) as CreateBody | null;
  if (!body) return c.json({ code: 400, msg: "invalid json body" }, 400);

  const goodsId = Number(body.goods_id);
  const quantity = Math.round(Number(body.quantity ?? 1));
  if (!Number.isInteger(goodsId) || goodsId <= 0) {
    return c.json({ code: 400, msg: "goods_id required" }, 400);
  }
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 999) {
    return c.json({ code: 400, msg: "quantity must be 1-999" }, 400);
  }
  const skuCode = typeof body.sku_code === "string" && body.sku_code.length > 0 ? body.sku_code : null;
  // M5-γ：支付方式白名单来自插件注册表（active_plugins 可停用通道）
  const payPluginRaw = String(body.pay_plugin);
  const payPlugin = isValidPayPlugin(payPluginRaw) ? payPluginRaw : "epay_ali";
  const tel = typeof body.tel === "string" ? body.tel.slice(0, 255) : "";
  const email = typeof body.email === "string" ? body.email.slice(0, 255) : "";
  const idemKey =
    typeof body.idempotency_key === "string" && body.idempotency_key.length > 0
      ? body.idempotency_key.slice(0, 64)
      : null;

  // ---- 事务：幂等建单 + 库存原子预留 + 子项 ----
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let orderId: number;
    let outTradeNo: string;
    let amountCents: number;

    if (idemKey) {
      const dup = await client.query(
        `SELECT id, out_trade_no, amount FROM dc_order WHERE idempotency_key = $1`,
        [idemKey],
      );
      if (dup.rows.length > 0) {
        await client.query("COMMIT");
        const o = dup.rows[0];
        return c.json({ code: 0, msg: "ok (idempotent replay)", data: o }, 200);
      }
    }

    const g = await client.query(
      `SELECT id, title, type, is_sku, stock, is_on_shelf, unit_name FROM dc_goods
       WHERE id = $1 AND station_id = 0 AND delete_time IS NULL FOR UPDATE`,
      [goodsId],
    );
    const goods = g.rows[0] as
      | { id: number; title: string; type: string; is_sku: string; stock: number; is_on_shelf: number }
      | undefined;
    if (!goods) throw Object.assign(new Error("goods not found"), { http: 404 as const });
    if (goods.is_on_shelf !== 1) throw Object.assign(new Error("goods off shelf"), { http: 403 as const });

    // 实物商品（ADR-005 P2）：必须登录 + 已有收货地址
    if (goods.type === "goods_physical") {
      if (!c.get("uid")) throw Object.assign(new Error("physical goods require login + address"), { http: 401 as const });
      const addr = await client.query(
        `SELECT id FROM dc_physical_address WHERE uid = $1`,
        [c.get("uid")],
      );
      if (addr.rows.length === 0) {
        throw Object.assign(new Error("set shipping address first"), { http: 400 as const });
      }
    }

    // 价格行：多规格按 code 精确取，单规格取默认 '0' 行
    const skuRow = await client.query(
      `SELECT code, sku, market_price, user_price, guest_price FROM dc_skus
       WHERE goods_id = $1 AND ($2::varchar IS NULL OR code = $2::varchar OR sku = $2::varchar)
       ORDER BY (code = $2::varchar) DESC NULLS LAST, (sku = '0') DESC
       LIMIT 1`,
      [goodsId, skuCode],
    );
    const sku = skuRow.rows[0] as { code: string | null; sku: string; market_price: number | null; user_price: number | null; guest_price: number | null } | undefined;
    if (!sku) throw Object.assign(new Error("sku not found"), { http: 404 as const });

    // 分店归属（M3 D5）：body.station_slug 解析激活分店（默认 0 主站）；station 供加价/停用校验
    let stationId = 0;
    let station: { id: number; status: number; master_goods: number } | null = null;
    const stationSlug = typeof body.station_slug === "string" ? body.station_slug.slice(0, 50) : "";
    if (stationSlug) {
      const st = await client.query(
        `SELECT id, status, master_goods FROM dc_station WHERE slug = $1 AND delete_time IS NULL LIMIT 1`,
        [stationSlug],
      );
      const row = st.rows[0] as { id: number; status: number; master_goods: number } | undefined;
      if (!row) throw Object.assign(new Error("station not found"), { http: 404 });
      if (row.status !== 1) throw Object.assign(new Error("当前分店已停用"), { http: 403 });
      stationId = row.id;
      station = { id: row.id, status: row.status, master_goods: row.master_goods ?? 1 };
    }

    // 价格链（M7 C2 对齐 Level_Service::getActiveLevelId）：等级过期视为无等级（掉 user_price 档）
    const userRow = await client.query<{ level: number; level_expire_time: number | null }>(
      `SELECT level, level_expire_time FROM dc_user WHERE uid = $1`,
      [c.get("uid") ?? 0],
    );
    const rawLevel = Number(userRow.rows[0]?.level ?? 0);
    const rawExpire = Number(userRow.rows[0]?.level_expire_time ?? 0);
    const levelActive = rawLevel > 0 && (rawExpire === 0 || rawExpire * 1000 > Date.now());
    const userLevel = levelActive ? rawLevel : 0;
    const isRegistered = (c.get("uid") ?? 0) > 0; // 注册普通用户吃 user_price，游客只吃 guest（上游 level==-1 语义）
    let unit: number;
    if (userLevel > 0) {
      const mp = await client.query(
        `SELECT price FROM dc_member_price WHERE goods_id = $1 AND sku = $2 AND member_level = $3 LIMIT 1`,
        [goodsId, sku.sku, userLevel],
      );
      // 会员：mp 覆盖 > user_price > guest（M7 C2 对齐 Level_Price::calculate）
      unit = mp.rows[0] ? Number(mp.rows[0].price) : unitPriceCents(sku, true);
    } else {
      unit = unitPriceCents(sku, isRegistered);
    }
    if (unit <= 0) throw Object.assign(new Error("price not set"), { http: 400 as const });
    const total = calcTotalCents(unit, quantity);

    // 批量优惠（M2）：取最优规则
    const rules = await client.query(
      `SELECT quantity, amount, type FROM dc_discount WHERE goods_id = $1 AND sku = $2`,
      [goodsId, sku.sku],
    );
    const best = applyBestDiscount(rules.rows, quantity, unit);
    let totalAfterDiscount = Math.max(total - best.discountCents, 0);

    // 分店价格链末环（M3 D5）：station premium 加价；映射表无记录且 master_goods=1 → 按主站价全同步
    if (station) {
      if (station.status !== 1) throw Object.assign(new Error("当前分店已停用"), { http: 403 });
      const map = await client.query<{ premium: string | null; is_show: string }>(
        `SELECT premium, is_show FROM dc_station_goods
         WHERE station_id = $1 AND goods_id = $2 LIMIT 1`,
        [station.id, goodsId],
      );
      const row = map.rows[0];
      const hidden = row?.is_show === "n";
      const mapped = row !== undefined;
      // 显式隐藏 → 不可购买；未映射且 master_goods != 1 → 不可购买
      if (hidden || (!mapped && station.master_goods !== 1)) {
        throw Object.assign(new Error("goods not available in this station"), { http: 403 });
      }
      const pct = row?.premium !== null && row?.premium !== undefined ? Number(row.premium) : null;
      if (pct !== null && !Number.isFinite(pct)) {
        throw Object.assign(new Error("bad premium"), { http: 500 });
      }
      if (pct !== null && pct < 0) {
        throw Object.assign(new Error("negative premium rejected"), { http: 500 });
      }
      totalAfterDiscount = applyStationPremium(totalAfterDiscount, pct);
    }

    if (goods.stock < quantity) throw Object.assign(new Error("out of stock"), { http: 409 as const });

    // 实物运费（ADR-005 P2）：满额包邮或 first+append*(qty-1)，加进 order.amount
    let shippingCents = 0;
    if (goods.type === "goods_physical") {
      const quote = await quoteShipping(pool, goodsId, quantity, totalAfterDiscount);
      shippingCents = quote?.feeCents ?? 0;
    }
    const orderAmount = totalAfterDiscount + shippingCents;

    const rs = await client.query(
      `UPDATE dc_goods SET stock = stock - $1 WHERE id = $2 AND stock >= $1`,
      [quantity, goodsId],
    );
    if (rs.rowCount !== 1) throw Object.assign(new Error("out of stock"), { http: 409 as const });

    const no = genOutTradeNo();
    const o = await client.query(
      `INSERT INTO dc_order (out_trade_no, amount, tel, email, pay_plugin, pay_status, status,
                            create_time, update_time, idempotency_key, client_ip, user_id, station_id)
       VALUES ($1, $2, $3, $4, $5, 0, 0, $6, $6, $7, $8, $9, $10)
       RETURNING id, out_trade_no, amount`,
      [no, orderAmount, tel, email, payPlugin, Date.now(), idemKey, c.req.header("x-forwarded-for") ?? "", c.get("uid") ?? 0, stationId],
    );
    orderId = o.rows[0].id as number;
    outTradeNo = o.rows[0].out_trade_no as string;
    amountCents = o.rows[0].amount as number;

    await client.query(
      `INSERT INTO dc_order_list (order_id, goods_id, sku, quantity, unit_price, price, status)
       VALUES ($1, $2, $3, $4, $5, $6, 0)`,
      [orderId, goodsId, sku.sku, quantity, unit, totalAfterDiscount],
    );

    await client.query("COMMIT");
    return c.json(
      { code: 0, msg: "ok", data: { out_trade_no: outTradeNo, amount: amountCents, goods: goods.title, quantity } },
      201,
    );
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    const e = err as Error & { http?: 400 | 403 | 404 | 409; code?: string };
    // 审查修复 L4：同 idempotency_key 并发下单撞唯一约束（23505）→ 幂等重放而非 500
    if (idemKey && e.code === "23505") {
      const dup = await pool.query(
        `SELECT id, out_trade_no, amount FROM dc_order WHERE idempotency_key = $1`,
        [idemKey],
      );
      if (dup.rows.length > 0) {
        return c.json({ code: 0, msg: "ok (idempotent replay)", data: dup.rows[0] }, 200);
      }
    }
    const status: 200 | 400 | 403 | 404 | 409 | 500 = e.http ?? 500;
    if (status === 500) console.error("[orders] create failed:", e.message);
    return c.json({ code: status, msg: e.message || "order create failed" }, status);
  } finally {
    client.release();
  }
});

ordersRoutes.get("/v1/shop/orders/:no", requireAuthOptional(), async (c) => {
  const pool = c.get("pool");
  const no = (c.req.param("no") ?? "").slice(0, 30);
  const o = await pool.query(
    `SELECT id, out_trade_no, amount, pay_status, status, payment, pay_plugin, pay_time,
            create_time, tel, email
     FROM dc_order WHERE out_trade_no = $1 AND delete_time IS NULL`,
    [no],
  );
  const order = o.rows[0] as
    | {
        id: number;
        out_trade_no: string;
        amount: number;
        pay_status: number;
        status: number;
        payment: string | null;
        pay_time: number | null;
        create_time: number | null;
      }
    | undefined;
  if (!order) return c.json({ code: 404, msg: "order not found" }, 404);

  const items = await pool.query(
    `SELECT ol.id, ol.goods_id, g.title AS goods_title, g.type AS goods_type, ol.sku,
            ol.quantity, ol.unit_price, ol.price, ol.status
     FROM dc_order_list ol LEFT JOIN dc_goods g ON g.id = ol.goods_id
     WHERE ol.order_id = $1`,
    [order.id],
  );
  let contents: string[] = [];
  if (order.status === 2) {
    const d = await pool.query<{ content: string }>(
      `SELECT content FROM dc_deliver WHERE order_id = $1 ORDER BY id ASC`,
      [order.id],
    );
    contents = d.rows.map((r) => r.content);
  }
  return c.json({
    code: 0,
    data: { order, items: items.rows, contents },
  });
});
