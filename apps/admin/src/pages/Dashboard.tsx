import { useEffect, useState } from "react";

import { getStats, type Stats } from "../api.js";

export default function Dashboard() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    getStats().then(setStats).catch((e) => setError(String(e.message)));
  }, []);

  if (error) return <p className="error">{error}</p>;
  if (!stats) return <p className="muted">加载中…</p>;

  const cards = [
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
        {cards.map((c) => (
          <div className="stat-card" key={c.label}>
            <p className="stat-label">{c.label}</p>
            <p className="stat-value">{c.value}</p>
          </div>
        ))}
      </div>

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
