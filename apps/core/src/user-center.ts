/**
 * M2 用户中心：我的订单 / 提现（申请冻结→审核→打款或驳回退回）。
 */
import { Hono } from "hono";

import { requireAuth } from "./lib/jwt.js";
import { adminPermGuard } from "./lib/admin-auth.js";
import { centsToYuan } from "./lib/trade.js";
import type { AppEnv } from "./index.js";

export const userCenterRoutes = new Hono<AppEnv>();

/** 我的订单（登录用户的全部订单）。 */
userCenterRoutes.get("/v1/user/orders", requireAuth(), async (c) => {
  const uid = c.get("uid");
  const pool = c.get("pool");
  const page = Math.max(1, Number(c.req.query("page") ?? 1));
  const limit = Math.min(50, Math.max(1, Number(c.req.query("limit") ?? 20)));
  const res = await pool.query(
    `SELECT o.id, o.out_trade_no, o.amount, o.pay_status, o.status, o.payment, o.create_time
     FROM dc_order o
     WHERE o.user_id = $1 AND o.delete_time IS NULL
     ORDER BY o.id DESC LIMIT $2 OFFSET $3`,
    [uid, limit, (page - 1) * limit],
  );
  return c.json({ code: 0, data: { list: res.rows, page, limit } });
});

/** 提现申请（余额冻结：扣余额 + withdraw 行 status=0 待审核）。 */
userCenterRoutes.post("/v1/user/withdraw", requireAuth(), async (c) => {
  const uid = c.get("uid");
  const pool = c.get("pool");
  const body = (await c.req.json().catch(() => null)) as
    | { amount_yuan?: number; method?: string; account?: string; realname?: string }
    | null;
  const amountYuan = Number(body?.amount_yuan);
  const method = String(body?.method ?? "alipay").slice(0, 50);
  const account = String(body?.account ?? "").slice(0, 100);
  const realname = String(body?.realname ?? "").slice(0, 50);
  if (!Number.isFinite(amountYuan) || amountYuan <= 0) {
    return c.json({ code: 400, msg: "amount_yuan must be > 0" }, 400);
  }
  if (!account || !realname) {
    return c.json({ code: 400, msg: "account and realname required" }, 400);
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const me = await client.query(`SELECT money FROM dc_user WHERE uid = $1 FOR UPDATE`, [uid]);
    const before = me.rows[0]?.money as string | undefined;
    if (before === undefined) throw Object.assign(new Error("user not found"), { http: 404 });
    const after = await client.query(
      `UPDATE dc_user SET money = money - $1::numeric WHERE uid = $2 AND money >= $1::numeric RETURNING money`,
      [amountYuan.toFixed(2), uid],
    );
    if (after.rowCount !== 1) throw Object.assign(new Error("insufficient balance"), { http: 409 });
    await client.query(
      `INSERT INTO dc_balance_log (user_id, plus, update_before, money, description, create_time)
       VALUES ($1, 'n', $2, $3, $4, $5)`,
      [uid, before, after.rows[0].money, `提现申请冻结 ¥${amountYuan.toFixed(2)}`, Date.now()],
    );
    const w = await client.query(
      `INSERT INTO dc_withdraw (user_id, amount, method, account, realname, status, create_time)
       VALUES ($1, $2, $3, $4, $5, 0, $6) RETURNING id`,
      [uid, amountYuan.toFixed(2), method, account, realname, Date.now()],
    );
    await client.query("COMMIT");
    return c.json({ code: 0, msg: "submitted", data: { withdraw_id: w.rows[0].id } }, 201);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    const e = err as Error & { http?: 400 | 404 | 409 };
    const status: 200 | 400 | 404 | 409 | 500 = e.http ?? 500;
    return c.json({ code: status, msg: e.message }, status);
  } finally {
    client.release();
  }
});

/** 我的提现记录。 */
userCenterRoutes.get("/v1/user/withdraw", requireAuth(), async (c) => {
  const uid = c.get("uid");
  const pool = c.get("pool");
  const res = await pool.query(
    `SELECT id, amount, method, account, realname, status, create_time, handle_remark
     FROM dc_withdraw WHERE user_id = $1 ORDER BY id DESC LIMIT 50`,
    [uid],
  );
  return c.json({ code: 0, data: res.rows });
});

/** 后台提现审核：通过（打款完成）/ 驳回（余额退回）。权限位 user.withdraw（M5-α：原 requireAuth+key
 *  双检查的 requireAuth 分支移除——admin 账号已从用户面隔离，adminPermGuard 全权负责）。 */
userCenterRoutes.post("/v1/admin/withdraw/:id/review", async (c) => {
  const denied = await adminPermGuard(c, "user.withdraw");
  if (denied) return denied;
  const pool = c.get("pool");
  const id = Number(c.req.param("id"));
  const body = (await c.req.json().catch(() => null)) as
    | { approve?: boolean; remark?: string; actual_amount_yuan?: number }
    | null;
  const approve = body?.approve === true;
  const remark = String(body?.remark ?? "").slice(0, 500);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const w = await client.query(
      `SELECT id, user_id, amount, status FROM dc_withdraw WHERE id = $1 FOR UPDATE`,
      [id],
    );
    const row = w.rows[0] as { id: number; user_id: number; amount: string; status: number } | undefined;
    if (!row) throw Object.assign(new Error("withdraw not found"), { http: 404 });
    if (row.status !== 0) throw Object.assign(new Error("already reviewed"), { http: 409 });

    if (approve) {
      // 审查修复 M2：打款流水须反映真实余额（申请冻结时已扣款，此刻余额不变），
      // 不能把提现金额填进 update_before/money 造成对账失真
      const actual = Math.max(0, Number(body?.actual_amount_yuan ?? row.amount));
      const cur = await client.query<{ money: string }>(
        `SELECT money FROM dc_user WHERE uid = $1 FOR UPDATE`,
        [row.user_id],
      );
      const nowMoney = cur.rows[0]?.money ?? "0";
      await client.query(
        `UPDATE dc_withdraw SET status = 1, handle_time = $2, finish_time = $2,
                actual_amount = $3, handle_remark = $4 WHERE id = $1`,
        [id, Date.now(), actual.toFixed(2), remark || "已打款"],
      );
      await client.query(
        `INSERT INTO dc_balance_log (user_id, plus, update_before, money, description, create_time)
         VALUES ($1, 'n', $2, $2, $3, $4)`,
        [row.user_id, nowMoney, `提现打款 ¥${row.amount}（提现单 #${id}）`, Date.now()],
      );
    } else {
      await client.query(
        `UPDATE dc_withdraw SET status = 2, reject_time = $2, handle_remark = $3 WHERE id = $1`,
        [id, Date.now(), remark || "驳回"],
      );
      // 审查修复 M2：退回流水的 before/after 取真实余额
      const back = await client.query<{ money: string }>(
        `UPDATE dc_user SET money = money + $1::numeric WHERE uid = $2 RETURNING money`,
        [row.amount, row.user_id],
      );
      const afterMoney = back.rows[0]?.money ?? "0";
      const beforeMoney = (Number(afterMoney) - Number(row.amount)).toFixed(2);
      await client.query(
        `INSERT INTO dc_balance_log (user_id, plus, update_before, money, description, create_time)
         VALUES ($1, 'y', $2, $3, $4, $5)`,
        [row.user_id, beforeMoney, afterMoney, `提现驳回退回 ¥${row.amount}（提现单 #${id}）`, Date.now()],
      );
    }
    await client.query("COMMIT");
    return c.json({ code: 0, msg: approve ? "approved" : "rejected" });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    const e = err as Error & { http?: 404 | 409 };
    const status: 200 | 404 | 409 | 500 = e.http ?? 500;
    return c.json({ code: status, msg: e.message }, status);
  } finally {
    client.release();
  }
});

/** 后台提现列表（权限位 user.withdraw）。 */
userCenterRoutes.get("/v1/admin/withdraws", async (c) => {
  const denied = await adminPermGuard(c, "user.withdraw");
  if (denied) return denied;
  const pool = c.get("pool");
  const res = await pool.query(
    `SELECT w.id, w.amount, w.method, w.account, w.realname, w.status, w.create_time, u.username
     FROM dc_withdraw w LEFT JOIN dc_user u ON u.uid = w.user_id
     ORDER BY w.id DESC LIMIT 100`,
  );
  return c.json({ code: 0, data: res.rows });
});

void centsToYuan;
