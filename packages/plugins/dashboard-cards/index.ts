/**
 * v1.2.0 运营插件③：后台仪表盘扩展卡片。
 * 经 registerDashboardCard 注册三张卡（GET /v1/admin/dashboard/cards 聚合，admin SPA 泛化渲染）：
 *   ① 近 7 日订单趋势（按日：单量/销售额）
 *   ② 近 30 日支付方式分布（stats）
 *   ③ 最近售后 5 条（list，perm=aftersale.manage——无该权限位的账号不渲染此卡）
 * 卡片 load 每请求现查（无缓存），单卡失败由宿主跳过不阻断整页。
 */
import { definePlugin } from "@gqshop/plugin-api";

const DAY_MS = 24 * 60 * 60 * 1000;

function yuan(cents: number): string {
  return (cents / 100).toFixed(2);
}

function fmtDate(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const AFTERSALE_STATUS: Record<number, string> = { 0: "待处理", 1: "已同意", 2: "已拒绝", 3: "已结单" };

export default definePlugin({
  name: "dashboard_cards",
  version: "1.0.0",
  description: "仪表盘扩展卡片：近 7 日订单趋势 / 近 30 日支付方式分布 / 最近售后（权限位过滤）",
  activate(ctx) {
    ctx.registerDashboardCard({
      id: "trend_7d",
      title: "近 7 日订单趋势",
      load: async (q) => {
        const cutoff = Date.now() - 7 * DAY_MS;
        const r = await q.query<{ rows: Array<{ d: string; cnt: number; sales: number }> }>(
          `SELECT to_char(to_timestamp(pay_time / 1000) AT TIME ZONE 'Asia/Shanghai', 'MM-DD') AS d,
                  COUNT(*)::int AS cnt, COALESCE(SUM(amount), 0)::int AS sales
           FROM gq_order
           WHERE pay_status = 1 AND pay_time >= $1 AND delete_time IS NULL
           GROUP BY 1 ORDER BY 1`,
          [cutoff],
        );
        const byDay = new Map(r.rows.map((row) => [row.d, row]));
        const rows: Array<Array<string | number>> = [];
        for (let i = 6; i >= 0; i--) {
          const d = fmtDate(Date.now() - i * DAY_MS);
          const hit = byDay.get(d);
          rows.push([d, hit?.cnt ?? 0, `¥${yuan(hit?.sales ?? 0)}`]);
        }
        return { type: "list", columns: ["日期", "支付订单", "销售额"], rows };
      },
    });

    ctx.registerDashboardCard({
      id: "pay_dist_30d",
      title: "近 30 日支付方式分布",
      load: async (q) => {
        const cutoff = Date.now() - 30 * DAY_MS;
        const r = await q.query<{ rows: Array<{ pay_plugin: string | null; cnt: number; sales: number }> }>(
          `SELECT pay_plugin, COUNT(*)::int AS cnt, COALESCE(SUM(amount), 0)::int AS sales
           FROM gq_order
           WHERE pay_status = 1 AND pay_time >= $1 AND delete_time IS NULL
           GROUP BY pay_plugin ORDER BY cnt DESC LIMIT 8`,
          [cutoff],
        );
        if (r.rows.length === 0) {
          return { type: "text", text: "近 30 日无支付订单" };
        }
        return {
          type: "stats",
          items: r.rows.map((row) => ({
            label: row.pay_plugin || "未指定",
            value: `¥${yuan(row.sales)}（${row.cnt} 单）`,
          })),
        };
      },
    });

    ctx.registerDashboardCard({
      id: "recent_aftersale",
      title: "最近售后",
      perm: "aftersale.manage",
      load: async (q) => {
        const r = await q.query<{ rows: Array<{ id: number; out_trade_no: string; goods_title: string; type: string; status: number; create_time: number }> }>(
          `SELECT id, out_trade_no, goods_title, type, status, create_time
           FROM gq_aftersale ORDER BY id DESC LIMIT 5`,
        );
        if (r.rows.length === 0) {
          return { type: "text", text: "暂无售后记录" };
        }
        const typeLabel = (t: string) => (t === "refund" ? "退款" : t === "resend" ? "补发" : "其他");
        return {
          type: "list",
          columns: ["ID", "订单号", "商品", "类型", "状态", "创建时间"],
          rows: r.rows.map((a) => [
            a.id,
            a.out_trade_no,
            a.goods_title,
            typeLabel(a.type),
            AFTERSALE_STATUS[a.status] ?? String(a.status),
            new Date(a.create_time * 1000).toLocaleString("zh-CN", { hour12: false }),
          ]),
        };
      },
    });

    ctx.log("仪表盘扩展卡片已注册：trend_7d / pay_dist_30d / recent_aftersale");
  },
});
