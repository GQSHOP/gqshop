/**
 * M3 分店资金结算（ADR-004 D7）。
 * 分店订单支付成功后：分店主应得 = 实付 − service_change%（按等级费率）入余额 + 流水（分店订单分成）。
 * 结算时点=支付即入账（上游 为后台统一结算；本实现即时入账，jobs 日切做对账兜底——
 * 实时性更强的同时保证流水留痕，行为差异记录在案，对齐版可在 M3-β 切换日切模式）。
 */
import type { Pool } from "pg";

/** 支付成功后给分店主入账分成。失败仅记日志，不影响主结算（与佣金链同策略）。 */
export async function payStationIncome(
  client: import("pg").PoolClient,
  orderId: number,
  stationId: number,
  amountCents: number,
): Promise<void> {
  try {
    if (!stationId || amountCents <= 0) return;
    const s = await client.query<{ owner_uid: number; service_change: string | null }>(
      `SELECT s.user_id AS owner_uid, l.service_change
       FROM gq_station s LEFT JOIN gq_station_level l ON l.id = s.level_id
       WHERE s.id = $1 AND s.status = 1 AND s.delete_time IS NULL LIMIT 1`,
      [stationId],
    );
    const st = s.rows[0];
    if (!st?.owner_uid) return;

    const rate = Number(st.service_change ?? "0"); // percent，等级种子 10→1
    const feeCents = Math.min(amountCents, Math.round((amountCents * rate) / 100));
    const incomeCents = amountCents - feeCents;
    if (incomeCents <= 0) return;

    const yuan = (incomeCents / 100).toFixed(2);
    const before = await client.query<{ money: string }>(
      `SELECT money FROM gq_user WHERE uid = $1 FOR UPDATE`,
      [st.owner_uid],
    );
    const after = await client.query<{ money: string }>(
      `UPDATE gq_user SET money = money + $1::numeric WHERE uid = $2 RETURNING money`,
      [yuan, st.owner_uid],
    );
    if (after.rows[0]) {
      await client.query(
        `INSERT INTO gq_balance_log (user_id, plus, update_before, money, description, create_time)
         VALUES ($1, 'y', $2, $3, $4, $5)`,
        [st.owner_uid, before.rows[0]?.money ?? "0", after.rows[0].money,
          `分店订单分成 #${orderId}（手续费 ${rate}%）`, Date.now()],
      );
    }
  } catch (err) {
    console.error(`[station-income] order ${orderId} settle failed:`, err);
  }
}
