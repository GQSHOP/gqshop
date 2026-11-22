import { useEffect, useState } from "react";

import { getOrders, type AdminOrder } from "../api.js";

export default function Orders() {
  const [list, setList] = useState<AdminOrder[]>([]);
  const [error, setError] = useState("");
  const [page, setPage] = useState(1);

  useEffect(() => {
    getOrders(page)
      .then((d) => setList(d.list))
      .catch((e) => setError(String(e.message)));
  }, [page]);

  return (
    <div>
      <h2 className="page-title">订单管理</h2>
      {error && <p className="error">{error}</p>}
      <table className="table">
        <thead>
          <tr>
            <th>订单号</th>
            <th>金额</th>
            <th>支付状态</th>
            <th>发货状态</th>
            <th>支付方式</th>
            <th>联系</th>
            <th>用户</th>
          </tr>
        </thead>
        <tbody>
          {list.map((o) => (
            <tr key={o.out_trade_no}>
              <td className="mono">{o.out_trade_no}</td>
              <td>¥{(o.amount / 100).toFixed(2)}</td>
              <td>{o.pay_status === 1 ? "已支付" : "待支付"}</td>
              <td>{o.status === 2 ? "已发货" : o.pay_status === 1 ? "待发货" : "-"}</td>
              <td>{o.payment ?? "-"}</td>
              <td>{o.tel || o.email || "-"}</td>
              <td>{o.username ?? "游客"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="toolbar">
        <button className="btn-ghost" disabled={page <= 1} onClick={() => setPage(page - 1)}>
          上一页
        </button>
        <span className="muted">第 {page} 页</span>
        <button className="btn-ghost" disabled={list.length === 0} onClick={() => setPage(page + 1)}>
          下一页
        </button>
      </div>
    </div>
  );
}
