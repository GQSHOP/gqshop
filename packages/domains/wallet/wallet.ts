/**
 * M2 钱包与分销：充值卡兑换 / 余额流水 / 邀请绑定与信息 / 后台充值卡生成。
 * 分销佣金在支付结算时入上级余额（见 pay.ts settlePayment）。
 */
import { Hono } from "hono";
import { randomBytes } from "node:crypto";

import { requireAuth } from "@gqshop/kernel";
import { adminPermGuard } from "@gqshop/kernel";
import type { AppEnv } from "@gqshop/kernel";

export const walletRoutes = new Hono<AppEnv>();

/** 充值卡兑换（原子：status 0→1 条件更新 + 余额入账 + 流水）。 */
walletRoutes.post("/v1/user/recharge/redeem", requireAuth(), async (c) => {
  const uid = c.get("uid");
  const pool = c.get("pool");
  const body = (await c.req.json().catch(() => null)) as { card_key?: string } | null;
  const cardKey = String(body?.card_key ?? "").trim().slice(0, 64);
  if (!cardKey) return c.json({ code: 400, msg: "card_key required" }, 400);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const card = await client.query(
      `SELECT id, amount FROM gq_recharge_card WHERE card_key = $1 AND status = 0 FOR UPDATE`,
      [cardKey],
    );
    const row = card.rows[0] as { id: number; amount: string } | undefined;
    if (!row) throw Object.assign(new Error("card invalid or already used"), { http: 404 });

    const me = await client.query(`SELECT money FROM gq_user WHERE uid = $1 FOR UPDATE`, [uid]);
    const before = me.rows[0]?.money as string;
    const after = await client.query(
      `UPDATE gq_user SET money = money + $1::numeric WHERE uid = $2 RETURNING money`,
      [row.amount, uid],
    );
    await client.query(
      `UPDATE gq_recharge_card SET status = 1, user_id = $1, use_time = $2, update_time = $2 WHERE id = $3`,
      [uid, Date.now(), row.id],
    );
    await client.query(
      `INSERT INTO gq_balance_log (user_id, plus, update_before, money, description, create_time)
       VALUES ($1, 'y', $2, $3, $4, $5)`,
      [uid, before, after.rows[0].money, `充值卡兑换 ${cardKey.slice(0, 8)}…`, Date.now()],
    );
    await client.query("COMMIT");
    return c.json({ code: 0, msg: "ok", data: { amount: row.amount, balance: after.rows[0].money } });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    const e = err as Error & { http?: 404 };
    const status: 200 | 404 | 500 = e.http ?? 500;
    return c.json({ code: status, msg: e.message }, status);
  } finally {
    client.release();
  }
});

/** 余额流水（分页）。 */
walletRoutes.get("/v1/user/balance/logs", requireAuth(), async (c) => {
  const uid = c.get("uid");
  const pool = c.get("pool");
  const page = Math.max(1, Number(c.req.query("page") ?? 1));
  const limit = Math.min(50, Math.max(1, Number(c.req.query("limit") ?? 20)));
  const res = await pool.query(
    `SELECT plus, update_before, money, description, create_time
     FROM gq_balance_log WHERE user_id = $1 ORDER BY id DESC LIMIT $2 OFFSET $3`,
    [uid, limit, (page - 1) * limit],
  );
  const me = await pool.query(`SELECT money FROM gq_user WHERE uid = $1`, [uid]);
  return c.json({
    code: 0,
    data: { list: res.rows, balance: me.rows[0]?.money ?? "0.00", page, limit },
  });
});

/** 邀请信息：我的邀请码 / 直推列表 / 累计佣金。 */
walletRoutes.get("/v1/user/invite", requireAuth(), async (c) => {
  const uid = c.get("uid");
  const pool = c.get("pool");
  const me = await pool.query(`SELECT invite_code, superior FROM gq_user WHERE uid = $1`, [uid]);
  const row = me.rows[0] as { invite_code: string; superior: number } | undefined;
  if (!row) return c.json({ code: 404, msg: "user not found" }, 404);
  const direct = await pool.query(
    `SELECT uid, username, create_time FROM gq_user WHERE superior = $1 ORDER BY uid DESC LIMIT 50`,
    [uid],
  );
  const commission = await pool.query(
    // gq_balance_log.money 是"变动后余额"（上游语义）——佣金合计按变动额累加
    `SELECT COALESCE(SUM(money - update_before),0)::numeric AS total FROM gq_balance_log
     WHERE user_id = $1 AND plus = 'y' AND description LIKE '分销佣金%'`,
    [uid],
  );
  return c.json({
    code: 0,
    data: {
      invite_code: row.invite_code,
      invite_url: `/register?invite=${row.invite_code}`,
      superior_uid: row.superior,
      direct_count: direct.rows.length,
      direct_list: direct.rows,
      commission_total: commission.rows[0].total,
    },
  });
});

/** 绑定上级（未绑定且自助，注册后补绑）。 */
walletRoutes.post("/v1/user/invite/bind", requireAuth(), async (c) => {
  const uid = c.get("uid");
  const pool = c.get("pool");
  const body = (await c.req.json().catch(() => null)) as { invite_code?: string } | null;
  const code = String(body?.invite_code ?? "").trim().slice(0, 16).toUpperCase();
  if (!code) return c.json({ code: 400, msg: "invite_code required" }, 400);
  const inviter = await pool.query(`SELECT uid FROM gq_user WHERE invite_code = $1 AND uid <> $2`, [code, uid]);
  const inviterUid = inviter.rows[0]?.uid as number | undefined;
  if (!inviterUid) return c.json({ code: 404, msg: "inviter not found" }, 404);
  await pool.query(`UPDATE gq_user SET superior = $1 WHERE uid = $2 AND superior = 0`, [inviterUid, uid]);
  return c.json({ code: 0, msg: "bound" });
});

/** 后台生成充值卡（权限位 user.recharge）。 */
walletRoutes.post("/v1/admin/recharge-cards", async (c) => {
  const denied = await adminPermGuard(c, "user.recharge");
  if (denied) return denied;
  const adminUid = 0;
  const pool = c.get("pool");
  const body = (await c.req.json().catch(() => null)) as { value_yuan?: number; count?: number } | null;
  const valueYuan = Number(body?.value_yuan);
  const count = Math.min(500, Math.max(1, Math.round(Number(body?.count ?? 1))));
  if (!Number.isFinite(valueYuan) || valueYuan <= 0) {
    return c.json({ code: 400, msg: "value_yuan (>0) required" }, 400);
  }
  const batchNo = randomBytes(4).toString("hex").toUpperCase();
  const keys: string[] = [];
  for (let i = 0; i < count; i++) {
    const key = `GQC${randomBytes(10).toString("hex").toUpperCase()}`;
    keys.push(key);
    await pool.query(
      `INSERT INTO gq_recharge_card (type, title, amount, card_key, status, batch_no, admin_uid, create_time)
       VALUES ('balance', '余额充值卡', $1, $2, 0, $3, $4, $5)`,
      [valueYuan.toFixed(2), key, batchNo, adminUid, Date.now()],
    );
  }
  return c.json({ code: 0, data: { batch_no: batchNo, value_yuan: valueYuan, count, card_keys: keys } }, 201);
});
