import { useEffect, useState } from "react";

import { getStats, getDashboardCards, type Stats, type DashboardCard } from "../api.js";

/** v1.2.0 插件卡片泛化渲染：stats / list / text 三形态（插件不注入前端代码）。 */
function PluginCard({ card }: { card: DashboardCard }) {
  return (
    <div className="plugin-card" style={{ border: "1px solid var(--line, #e5e7eb)", borderRadius: 8, padding: "12px 16px", background: "var(--bg, #fff)" }}>
      <p className="stat-label" style={{ marginBottom: 8 }}>
        {card.title} <span className="muted" style={{ fontSize: 12 }}>· {card.plugin}</span>
      </p>
      {card.data.type === "stats" && (
        <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
          {card.data.items.map((it) => (
            <div key={it.label}>
              <p className="stat-label">{it.label}</p>
              <p className="stat-value" style={{ fontSize: 18 }}>{it.value}</p>
            </div>
          ))}
        </div>
      )}
      {card.data.type === "list" && (
        <table className="table" style={{ marginTop: 0 }}>
          <thead>
            <tr>{card.data.columns.map((col) => <th key={col}>{col}</th>)}</tr>
          </thead>
          <tbody>
            {card.data.rows.map((row, i) => (
              <tr key={i}>{row.map((cell, j) => <td key={j}>{cell}</td>)}</tr>
            ))}
          </tbody>
        </table>
      )}
      {card.data.type === "text" && <p className="muted" style={{ margin: 0 }}>{card.data.text}</p>}
    </div>
  );
}

export default function Dashboard() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [cards, setCards] = useState<DashboardCard[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    getStats().then(setStats).catch((e) => setError(String(e.message)));
    getDashboardCards().then((d) => setCards(d.cards)).catch(() => setCards([])); // 卡片失败不阻断仪表盘
  }, []);

  if (error) return <p className="error">{error}</p>;
  if (!stats) return <p className="muted">加载中…</p>;

  const statCards = [
    { label: "今日订单", value: stats.today_orders },
    { label: "今日销售额（元）", value: (stats.today_sales / 100).toFixed(2) },
    { label: "商品数", value: stats.goods_count },
    { label: "总库存", value: stats.stock_total },
    { label: "注册用户", value: stats.user_count },
  ];

  return (
    <div>
      <h2 className="page-title">仪表盘</h2>
      <div className="stat-grid">
        {statCards.map((c) => (
          <div className="stat-card" key={c.label}>
            <p className="stat-label">{c.label}</p>
            <p className="stat-value">{c.value}</p>
          </div>
        ))}
      </div>

      {cards.length > 0 && (
        <>
          <h3 className="section-title">插件扩展卡片</h3>
          <div style={{ display: "grid", gap: 12 }}>
            {cards.map((card) => <PluginCard key={`${card.plugin}:${card.id}`} card={card} />)}
          </div>
        </>
      )}

      <h3 className="section-title">库存预警（≤5）</h3>
      {stats.low_stock.length === 0 ? (
        <p className="muted">无预警商品</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>ID</th>
              <th>商品</th>
              <th>类型</th>
              <th>库存</th>
            </tr>
          </thead>
          <tbody>
            {stats.low_stock.map((g) => (
              <tr key={g.id} className={g.stock === 0 ? "danger" : ""}>
                <td>{g.id}</td>
                <td>{g.title}</td>
                <td>{g.type}</td>
                <td>{g.stock}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
