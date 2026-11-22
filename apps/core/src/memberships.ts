/**
 * M2 会员体系：8 档种子（上游 install.sql 原值）+ 等级购买 + 会员价链。
 * 价格链（16.3 灵魂 #5 落地，M2-α 范围）：member_price 覆盖 > SKU 默认价。
 */
import { Hono } from "hono";
import { and, eq } from "drizzle-orm";

import { memberPriceTable, memberTable, userTable } from "@gqshop/db";
import { requireAuth } from "./lib/jwt.js";
import { payUpgradeCommission } from "./lib/commission.js";
import { adminPermGuard } from "./lib/admin-auth.js";
import type { AppEnv } from "./index.js";

export const MEMBER_SEEDS = [
  { name: "普通用户", icon: "ri-user-smile-line", price: "0.00", duration_days: 0, is_default: 1, upgrade_direct_count: 0, sort: 1, actual_profit: "10.00", profit_threshold: "3.00", content: "注册即拥有。" },
  { name: "铜牌会员", icon: "ri-coin-line", price: "9.90", duration_days: 0, is_default: 0, upgrade_direct_count: 2, sort: 2, actual_profit: "12.00", profit_threshold: "3.00", content: "铜牌会员，解锁首档会员价。" },
  { name: "银牌会员", icon: "ri-medal-line", price: "19.90", duration_days: 0, is_default: 0, upgrade_direct_count: 5, sort: 3, actual_profit: "14.00", profit_threshold: "2.00", content: "银牌会员，拿货成本更低。" },
  { name: "金牌会员", icon: "ri-award-line", price: "39.90", duration_days: 0, is_default: 0, upgrade_direct_count: 10, sort: 4, actual_profit: "16.00", profit_threshold: "2.00", content: "金牌会员，主力销售等级。" },
  { name: "铂金代理", icon: "ri-vip-crown-line", price: "69.90", duration_days: 0, is_default: 0, upgrade_direct_count: 20, sort: 5, actual_profit: "18.00", profit_threshold: "2.00", content: "铂金代理，适合开店经营。" },
  { name: "钻石代理", icon: "ri-vip-diamond-line", price: "99.90", duration_days: 0, is_default: 0, upgrade_direct_count: 35, sort: 6, actual_profit: "20.00", profit_threshold: "1.00", content: "钻石代理，更强价格优势。" },
  { name: "黑金代理", icon: "ri-shield-star-line", price: "149.90", duration_days: 0, is_default: 0, upgrade_direct_count: 50, sort: 7, actual_profit: "22.00", profit_threshold: "1.00", content: "黑金代理，核心运营等级。" },
  { name: "核心合伙人", icon: "ri-star-smile-line", price: "199.90", duration_days: 0, is_default: 0, upgrade_direct_count: 100, sort: 8, actual_profit: "25.00", profit_threshold: "1.00", content: "核心合伙人，最高等级。" },
];

/** 幂等种子：dc_member 为空才写入（保留运营期手动改动）。
 *  M7 C1：补 actual_profit/profit_threshold（上游 install.sql 原值）；
 *  存量行若仍是全默认值（100/0）且名字匹配种子则原值刷新一次（幂等，手动改过则跳过）。 */
export async function seedMemberships(pool: import("pg").Pool): Promise<void> {
  const r = await pool.query(`SELECT COUNT(*)::int AS n FROM dc_member`);
  if (r.rows[0].n > 0) {
    for (const m of MEMBER_SEEDS) {
      await pool.query(
        `UPDATE dc_member SET actual_profit = $2, profit_threshold = $3
         WHERE name = $1 AND actual_profit = '100.00' AND profit_threshold = '0.00'`,
        [m.name, m.actual_profit, m.profit_threshold],
      );
    }
    return;
  }
  for (const m of MEMBER_SEEDS) {
    await pool.query(
      `INSERT INTO dc_member (name, icon, price, duration_days, is_default, sort, state, actual_profit, profit_threshold, content, create_time, update_time)
       VALUES ($1, $2, $3, $4, $5, $6, 1, $7, $8, $9, $10, $10)`,
      [m.name, m.icon, m.price, m.duration_days, m.is_default, m.sort, m.actual_profit, m.profit_threshold, m.content, Date.now()],
    );
  }
}

/** 会员价覆盖（覆盖语义）：命中返回分价，未命中返回 null。 */
export async function memberPriceCents(
  pool: import("pg").Pool,
  goodsId: number,
  sku: string,
  levelId: number,
): Promise<number | null> {
  const r = await pool.query<{ price: string }>(
    `SELECT price FROM dc_member_price
     WHERE goods_id = $1 AND sku = $2 AND member_level = $3 LIMIT 1`,
    [goodsId, sku, levelId],
  );
  return r.rows[0] ? Number(r.rows[0].price) : null;
}

export const membershipRoutes = new Hono<AppEnv>();

/** 等级列表（公开）。 */
membershipRoutes.get("/v1/shop/memberships", async (c) => {
  const pool = c.get("pool");
  const rows = await pool.query(
    `SELECT id, name, icon, price, duration_days, content, upgrade_direct_count, is_default
     FROM dc_member WHERE state = 1 ORDER BY sort ASC`,
  );
  return c.json({ code: 0, data: rows.rows });
});

/** 当前等级信息（登录）。 */
membershipRoutes.get("/v1/user/level", requireAuth(), async (c) => {
  const uid = c.get("uid");
  if (!uid) return c.json({ code: 401, msg: "login required" }, 401);
  const pool = c.get("pool");
  const u = await pool.query(
    `SELECT u.uid, u.level, u.level_expire_time, m.name AS level_name, m.icon AS level_icon
     FROM dc_user u LEFT JOIN dc_member m ON m.id = u.level WHERE u.uid = $1`,
    [uid],
  );
  const rows = u.rows[0] as { uid: number; level: number; level_expire_time: string; level_name: string | null; level_icon: string | null } | undefined;
  if (!rows) return c.json({ code: 404, msg: "user not found" }, 404);
  return c.json({ code: 0, data: rows });
});

/** 等级购买（余额支付，上游语义：等级订单 + 余额扣款 + 永久/到期时间）。 */
membershipRoutes.post("/v1/user/level/purchase", requireAuth(), async (c) => {
  const uid = c.get("uid");
  if (!uid) return c.json({ code: 401, msg: "login required" }, 401);
  const pool = c.get("pool");
  const body = (await c.req.json().catch(() => null)) as { level_id?: number } | null;
  const levelId = Number(body?.level_id);
  if (!Number.isInteger(levelId) || levelId <= 0) {
    return c.json({ code: 400, msg: "level_id required" }, 400);
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const m = await client.query(
      `SELECT id, name, price, duration_days FROM dc_member WHERE id = $1 AND state = 1 FOR UPDATE`,
      [levelId],
    );
    const member = m.rows[0] as { id: number; name: string; price: string; duration_days: number } | undefined;
    if (!member) throw Object.assign(new Error("level not found"), { http: 404 });
    const priceYuan = member.price;
    if (Number(priceYuan) <= 0) throw Object.assign(new Error("level is free by default"), { http: 400 });

    const me = await client.query(`SELECT level, level_expire_time, money FROM dc_user WHERE uid = $1 FOR UPDATE`, [uid]);
    const meRow = me.rows[0] as { level: number; level_expire_time: string | null; money: string };
    if (meRow.level === levelId) throw Object.assign(new Error("already at this level"), { http: 409 });

    const deducted = await client.query(
      `UPDATE dc_user SET money = money - $1::numeric WHERE uid = $2 AND money >= $1::numeric RETURNING money`,
      [priceYuan, uid],
    );
    if (deducted.rowCount !== 1) throw Object.assign(new Error("insufficient balance"), { http: 409 });

    const now = Date.now();
    const outTradeNo = `GL${now}${Math.floor(Math.random() * 1e6).toString().padStart(6, "0")}`.slice(0, 32);
    const oldExpire = meRow.level_expire_time ? Number(meRow.level_expire_time) : 0;
    // M2-α：上游 种子全部 duration_days=0（永久）；续费差价/到期扩展 M2-β
    const newExpire = member.duration_days > 0 ? now + member.duration_days * 86400000 : 0;

    await client.query(
      `INSERT INTO dc_balance_log (user_id, plus, update_before, money, description, create_time)
       VALUES ($1, 'n', $2, $3, $4, $5)`,
      [uid, meRow.money, deducted.rows[0].money, `购买会员等级 ${member.name}`, now],
    );
    await client.query(
      `INSERT INTO dc_level_order (out_trade_no, user_id, level_id, purchase_type, duration_days,
                                   amount, base_price, old_level_id, old_expire_time, new_expire_time,
                                   state, create_time, complete_time)
       VALUES ($1, $2, $3, 'open', $4, $5, $5, $6, $7, $8, 1, $9, $9)`,
      [outTradeNo, uid, member.id, member.duration_days, priceYuan, meRow.level, oldExpire, newExpire, now],
    );
    await client.query(
      `UPDATE dc_user SET level = $1, level_expire_time = $2 WHERE uid = $3`,
      [member.id, newExpire, uid],
    );
    // M7 C1（payUpgrade 等价）：下级升级，直属上级按 level_upgrade_profit% 奖励（默认 0=关）
    await payUpgradeCommission(client, uid, Math.round(Number(priceYuan) * 100), member.id, outTradeNo);
    await client.query("COMMIT");
    return c.json({ code: 0, msg: "ok", data: { level: member.id, level_name: member.name, out_trade_no: outTradeNo } });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    const e = err as Error & { http?: 400 | 404 | 409 };
    const status: 200 | 400 | 404 | 409 | 500 = e.http ?? 500;
    return c.json({ code: status, msg: e.message }, status);
  } finally {
    client.release();
  }
});

/** 会员价管理（后台）：设置某商品 SKU 的等级覆盖价。 */
membershipRoutes.post("/v1/admin/member-price", async (c) => {
  const denied = await adminPermGuard(c, "goods.manage");
  if (denied) return denied;
  const pool = c.get("pool");
  const body = (await c.req.json().catch(() => null)) as
    | { goods_id?: number; sku?: string; level_id?: number; price?: number }
    | null;
  const goodsId = Number(body?.goods_id);
  const sku = String(body?.sku ?? "0").slice(0, 50);
  const levelId = Number(body?.level_id);
  const priceCents = Math.round(Number(body?.price));
  if (!goodsId || !levelId || !Number.isFinite(priceCents) || priceCents < 0) {
    return c.json({ code: 400, msg: "goods_id/level_id/price(cents) required" }, 400);
  }
  await pool.query(
    `DELETE FROM dc_member_price WHERE goods_id = $1 AND sku = $2 AND member_level = $3`,
    [goodsId, sku, levelId],
  );
  await pool.query(
    `INSERT INTO dc_member_price (goods_id, sku, member_level, price)
     VALUES ($1, $2, $3, $4)`,
    [goodsId, sku, levelId, priceCents],
  );
  const updated = await pool.query(
    `SELECT goods_id, sku, member_level, price FROM dc_member_price
     WHERE goods_id = $1 AND sku = $2 AND member_level = $3`,
    [goodsId, sku, levelId],
  );
  return c.json({ code: 0, data: updated.rows[0] }, 201);
});

void and(eq(memberTable.is_default, 1), eq(memberTable.state, 1));
