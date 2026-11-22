/**
 * 定时任务（A11 落地）：订单超时关闭 + 库存释放。
 * 规则：pay_status=0 AND status=0 且创建超过 30 分钟 → status=3（关闭），逐子项回补库存。
 * 迟到回调的恢复逻辑在 settlePayment（status=3 → 重新打开 + 补扣库存）。
 */
import type { Pool } from "pg";

const TIMEOUT_MS = 30 * 60 * 1000; // 30 分钟

export async function closeExpiredOrders(pool: Pool): Promise<number> {
  const client = await pool.connect();
  let closed = 0;
  try {
    await client.query("BEGIN");
    const expired = await client.query<{ id: number; out_trade_no: string }>(
      `SELECT id, out_trade_no FROM dc_order
       WHERE pay_status = 0 AND status = 0 AND create_time < $1 AND delete_time IS NULL
       ORDER BY id ASC LIMIT 50 FOR UPDATE SKIP LOCKED`,
      [Date.now() - TIMEOUT_MS],
    );
    for (const o of expired.rows) {
      const upd = await client.query(
        `UPDATE dc_order SET status = 3, update_time = $2 WHERE id = $1 AND pay_status = 0 AND status = 0`,
        [o.id, Date.now()],
      );
      if (upd.rowCount !== 1) continue;
      const items = await client.query<{ goods_id: number; quantity: number }>(
        `SELECT goods_id, quantity FROM dc_order_list WHERE order_id = $1`,
        [o.id],
      );
      for (const it of items.rows) {
        if (!it.goods_id) continue;
        await client.query(`UPDATE dc_goods SET stock = stock + $1 WHERE id = $2`, [
          it.quantity ?? 1,
          it.goods_id,
        ]);
      }
      closed++;
    }
    await client.query("COMMIT");
    if (closed > 0) console.log(`[jobs] closed ${closed} expired orders`);
    return closed;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("[jobs] closeExpiredOrders error:", err);
    return closed;
  } finally {
    client.release();
  }
}

export function startJobs(pool: Pool): void {
  // 启动即跑一次 + 每 60 秒一轮
  void closeExpiredOrders(pool);
  const timer = setInterval(() => {
    void closeExpiredOrders(pool);
  }, 60_000);
  timer.unref?.();
  console.log("[jobs] order-timeout job started (60s interval, 30min timeout)");
}
