/**
 * 今日快照插件：仪表盘单卡片（stats 型）。
 * 今日新订单数 / 今日支付 GMV / 待支付订单 / 待处理售后——按 Asia/Shanghai 自然日切分。
 */
export default {
  name: "today_snapshot",
  version: "1.0.0",
  description: "仪表盘「今日快照」：今日订单/GMV/待支付/待处理售后",
  activate(ctx) {
    /** Asia/Shanghai 今日 0 点对应的 UTC 毫秒。 */
    const todayStartMs = () => {
      const shifted = new Date(Date.now() + 8 * 3600 * 1000); // 东八区墙上时间，用 UTC 取数
      return Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) - 8 * 3600 * 1000;
    };
    ctx.registerDashboardCard({
      id: "today_snapshot",
      title: "今日快照",
      load: async (q) => {
        const start = todayStartMs();
        const [created, paid, pending, aftersale] = await Promise.all([
          q.query(`SELECT COUNT(*)::int AS cnt FROM gq_order WHERE create_time >= $1 AND delete_time IS NULL`, [start]),
          q.query(`SELECT COUNT(*)::int AS cnt, COALESCE(SUM(amount),0)::int AS gmv FROM gq_order WHERE pay_status = 1 AND pay_time >= $1 AND delete_time IS NULL`, [start]),
          q.query(`SELECT COUNT(*)::int AS cnt FROM gq_order WHERE pay_status = 0 AND delete_time IS NULL AND (expire_time IS NULL OR expire_time = 0 OR expire_time > $1)`, [Date.now()]),
          q.query(`SELECT COUNT(*)::int AS cnt FROM gq_aftersale WHERE status = 0`),
        ]);
        const gmv = paid.rows[0].gmv;
        return {
          type: "stats",
          items: [
            { label: "今日订单", value: `${created.rows[0].cnt} 单` },
            { label: "今日支付 GMV", value: `¥${(gmv / 100).toFixed(2)}（${paid.rows[0].cnt} 单）` },
            { label: "待支付", value: `${pending.rows[0].cnt} 单` },
            { label: "待处理售后", value: `${aftersale.rows[0].cnt} 条` },
          ],
        };
      },
    });
    ctx.log("今日快照卡片已注册");
  },
};
