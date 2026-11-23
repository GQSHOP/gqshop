/**
 * 等级到期降级 job（功能池①，对齐上游到期掉档语义）：
 * 价格链在下单时已按 getActiveLevelId 过期掉档（orders.ts），本 job 把过期等级物理归零——
 * 佣金链等级门槛、用户中心展示、分店等级权益与实际一致。
 * 语义：level>=2（付费档）且 level_expire_time 已过 → level=0（注册态）；
 * 保留 level_expire_time 历史值（续费按 max(now, oldExpire) 起算，过期残值不会误顺延）。
 */
import type { Pool } from "pg";

export async function downgradeExpiredLevels(pool: Pool): Promise<number> {
  const r = await pool.query<{ uid: number }>(
    `UPDATE gq_user SET level = 0
     WHERE level >= 2
       AND level_expire_time IS NOT NULL
       AND level_expire_time > 0
       AND level_expire_time <= $1
     RETURNING uid`,
    [Date.now()],
  );
  if (r.rowCount && r.rowCount > 0) {
    console.log(`[jobs:members] downgraded ${r.rowCount} expired member(s): uid=[${r.rows.map((u) => u.uid).join(", ")}]`);
  }
  return r.rowCount ?? 0;
}

export function startMembersJobs(pool: Pool): void {
  // 启动即查一次 + 每 5 分钟一轮（到期是慢变化，无需高频）
  void downgradeExpiredLevels(pool).catch((err) => console.error("[jobs:members] downgrade error:", err));
  const timer = setInterval(
    () => void downgradeExpiredLevels(pool).catch((err) => console.error("[jobs:members] downgrade error:", err)),
    5 * 60_000,
  );
  timer.unref?.();
  console.log("[jobs:members] level-expiry job started (5min interval)");
}
