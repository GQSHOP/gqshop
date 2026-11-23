/**
 * M3 分店资金结算（ADR-004 D7）。
 * 分店订单支付成功后：分店主应得 = 实付 − service_change%（按等级费率）入余额 + 流水（分店订单分成）。
 * 结算时点=支付即入账（上游 为后台统一结算；本实现即时入账，jobs 日切做对账兜底——
 * 实时性更强的同时保证流水留痕，行为差异记录在案，对齐版可在 M3-β 切换日切模式）。
 * 功能池④：结算后 tryAutoUpgrade——按 gq_station_level.upgrade_* 阈值自动升档（总开关默认关）。
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
    await tryAutoUpgrade(client, stationId).catch((err) =>
      console.error(`[station-income] order ${orderId} tryAutoUpgrade failed:`, err),
    );
  } catch (err) {
    console.error(`[station-income] order ${orderId} settle failed:`, err);
  }
}

/**
 * 分店自动升档（功能池④，上游 tryAutoUpgrade 的 GQSHOP 语义）：
 * 总开关 gq_options station_auto_upgrade='y'（默认关）；逐级爬升（可能一次跨多档）。
 * 目标档=sort 严格大于当前档的最低档；按其 upgrade_* 阈值判定（阈值 0=不限）：
 *   销售额（该店累计支付 GMV 分）、订单数、开店天数、下级分店数（GQSHOP 暂无父子关系=仅阈值 0 可过）。
 * upgrade_mode：'any'=任一条件达标即升；'all'=全部启用条件（阈值>0）须同时达标。
 */
export async function tryAutoUpgrade(client: import("pg").PoolClient, stationId: number): Promise<void> {
  const sw = await client.query<{ option_value: string }>(
    `SELECT option_value FROM gq_options WHERE option_name = 'station_auto_upgrade' LIMIT 1`,
  );
  if (sw.rows[0]?.option_value !== "y") return;
  for (let hop = 0; hop < 10; hop++) {
    const cur = await client.query<{ level_id: number; create_time: string | null }>(
      `SELECT level_id, create_time FROM gq_station WHERE id = $1 AND delete_time IS NULL LIMIT 1`,
      [stationId],
    );
    const station = cur.rows[0];
    if (!station) return;
    const next = await client.query<{
      id: number; name: string | null; upgrade_mode: string; upgrade_sales_amount: string;
      upgrade_order_count: number; upgrade_days: number; upgrade_sub_count: number;
    }>(
      `SELECT id, name, upgrade_mode, upgrade_sales_amount, upgrade_order_count, upgrade_days, upgrade_sub_count
       FROM gq_station_level
       WHERE sort > (SELECT sort FROM gq_station_level WHERE id = $1) AND "using" = 'y'
       ORDER BY sort ASC LIMIT 1`,
      [station.level_id],
    );
    const lv = next.rows[0];
    if (!lv) return; // 已顶档
    const gmv = await client.query<{ total: string; cnt: string }>(
      `SELECT COALESCE(SUM(amount), 0)::bigint AS total, COUNT(*)::int AS cnt
       FROM gq_order WHERE station_id = $1 AND pay_status = 1 AND delete_time IS NULL`,
      [stationId],
    );
    const salesCents = Number(gmv.rows[0]?.total ?? 0);
    const orderCount = Number(gmv.rows[0]?.cnt ?? 0);
    const days = Math.floor((Date.now() - Number(station.create_time ?? 0)) / 86_400_000);
    const subCount = 0; // GQSHOP 分店无父子层级（上游 sub 分店体系未移植），仅阈值 0 视为达标
    const conds: Array<[string, number, number]> = [
      ["sales", salesCents, Math.round(Number(lv.upgrade_sales_amount ?? 0) * 100)],
      ["orders", orderCount, lv.upgrade_order_count ?? 0],
      ["days", days, lv.upgrade_days ?? 0],
      ["subs", subCount, lv.upgrade_sub_count ?? 0],
    ];
    const enabled = conds.filter(([, , threshold]) => threshold > 0);
    if (enabled.length === 0) return; // 下一档未设阈值=不自动升（防误升）
    const met = enabled.filter(([, actual, threshold]) => actual >= threshold);
    const ok = lv.upgrade_mode === "all" ? met.length === enabled.length : met.length > 0;
    if (!ok) return;
    const upd = await client.query(
      `UPDATE gq_station SET level_id = $1 WHERE id = $2 AND level_id = $3 RETURNING id`,
      [lv.id, stationId, station.level_id],
    );
    if (upd.rowCount !== 1) return; // 并发升档，另一路已处理
    console.log(`[station] auto-upgrade station#${stationId} → level "${lv.name}"(#${lv.id})（GMV ¥${(salesCents / 100).toFixed(2)}/${orderCount} 单）`);
  }
}
