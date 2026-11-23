/**
 * 高级统计插件（付费）：仪表盘三卡。
 * ① 近 30 日商品销量 Top10（按支付订单明细聚合，list 型）；
 * ② 近 30 日下单→支付转化率（stats 型：下单数/支付数/转化率/客单价）；
 * ③ 买家复购（近 30 日有支付行为的买家中，支付 ≥2 单的占比 + 累计复购买家数）。
 */
export default {
  name: "advanced_stats",
  version: "1.0.0",
  description: "高级统计三卡：商品销量 Top10 / 支付转化率 / 买家复购率",
  activate(ctx) {
    const DAY_MS = 24 * 60 * 60 * 1000;
    const yuan = (cents) => `¥${(cents / 100).toFixed(2)}`;

    ctx.registerDashboardCard({
      id: "top_goods_30d",
      title: "近 30 日商品销量 Top10",
      load: async (q) => {
        const cutoff = Date.now() - 30 * DAY_MS;
        const r = await q.query(
          `SELECT l.goods_id, COALESCE(g.title, '已删除#' || l.goods_id) AS title,
                  SUM(l.quantity)::int AS qty, SUM(l.price)::int AS sales
           FROM gq_order_list l
           JOIN gq_order o ON o.id = l.order_id
           LEFT JOIN gq_goods g ON g.id = l.goods_id
           WHERE o.pay_status = 1 AND o.pay_time >= $1 AND o.delete_time IS NULL
           GROUP BY l.goods_id, g.title
           ORDER BY qty DESC, sales DESC LIMIT 10`,
          [cutoff],
        );
        if (r.rows.length === 0) return { type: "text", text: "近 30 日无支付订单" };
        return {
          type: "list",
          columns: ["#", "商品", "件数", "销售额"],
          rows: r.rows.map((row, i) => [i + 1, row.title, row.qty, yuan(row.sales)]),
        };
      },
    });

    ctx.registerDashboardCard({
      id: "conversion_30d",
      title: "近 30 日支付转化",
      load: async (q) => {
        const cutoff = Date.now() - 30 * DAY_MS;
        const r = await q.query(
          `SELECT
             COUNT(*) FILTER (WHERE create_time >= $1)::int AS created,
             COUNT(*) FILTER (WHERE pay_status = 1 AND pay_time >= $1)::int AS paid,
             COALESCE(SUM(amount) FILTER (WHERE pay_status = 1 AND pay_time >= $1), 0)::bigint AS gmv
           FROM gq_order WHERE delete_time IS NULL`,
          [cutoff],
        );
        const { created, paid, gmv } = r.rows[0];
        const rate = created > 0 ? `${((paid / created) * 100).toFixed(1)}%` : "—";
        const aov = paid > 0 ? yuan(Number(gmv) / paid) : "—";
        return {
          type: "stats",
          items: [
            { label: "下单", value: `${created} 单` },
            { label: "支付", value: `${paid} 单` },
            { label: "转化率", value: rate },
            { label: "支付客单价", value: aov },
          ],
        };
      },
    });

    ctx.registerDashboardCard({
      id: "repurchase_30d",
      title: "近 30 日买家复购",
      load: async (q) => {
        const cutoff = Date.now() - 30 * DAY_MS;
        const r = await q.query(
          `SELECT
             COUNT(DISTINCT user_id)::int AS buyers,
             COUNT(DISTINCT user_id) FILTER (WHERE cnt >= 2)::int AS repeat_buyers
           FROM (
             SELECT user_id, COUNT(*)::int AS cnt
             FROM gq_order
             WHERE pay_status = 1 AND pay_time >= $1 AND delete_time IS NULL AND user_id > 0
             GROUP BY user_id
           ) t`,
          [cutoff],
        );
        const { buyers, repeat_buyers } = r.rows[0];
        const rate = buyers > 0 ? `${((repeat_buyers / buyers) * 100).toFixed(1)}%` : "—";
        return {
          type: "stats",
          items: [
            { label: "支付买家", value: `${buyers} 人` },
            { label: "复购买家", value: `${repeat_buyers} 人` },
            { label: "复购率", value: rate },
          ],
        };
      },
    });

    ctx.log("高级统计卡片已注册：top_goods_30d / conversion_30d / repurchase_30d");
  },
};
