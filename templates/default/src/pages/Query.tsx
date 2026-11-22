import { useState } from "react";

import { getOrder, type OrderView } from "../api.js";

export default function OrderQuery() {
  const [no, setNo] = useState("");
  const [order, setOrder] = useState<OrderView | null>(null);
  const [error, setError] = useState("");

  async function query() {
    setError("");
    setOrder(null);
    try {
      setOrder(await getOrder(no.trim()));
    } catch (e) {
      setError(String((e as Error).message));
    }
  }

  return (
    <main className="container page">
      <div className="query-card">
        <h2>轻松查询订单，即刻享受自动交易</h2>
        <div className="query-bar">
          <input
            placeholder="请输入预留联系方式/订单号"
            value={no}
            onChange={(e) => setNo(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && query()}
          />
          <button className="btn-primary" onClick={query}>
            查询订单
          </button>
        </div>
        {error && <p className="error">{error}</p>}

        {order && (
          <div className="result-card">
            <h3>
              订单 {order.order.out_trade_no} —{" "}
              {order.order.status === 2 ? "已完成" : order.order.pay_status === 1 ? "已支付待发货" : "待支付"}
            </h3>
            <ul className="items">
              {order.items.map((it, i) => (
                <li key={i}>
                  {it.goods_title} × {it.quantity}
                </li>
              ))}
            </ul>
            {order.contents.length > 0 && (
              <>
                <h3>发货内容（卡密）</h3>
                <pre className="cards">{order.contents.join("\n\n")}</pre>
              </>
            )}
          </div>
        )}

        <div className="notice">
          <strong>查单提醒</strong>
          <p>联系信息不要泄露给他人，如遗忘请联系客服找回！</p>
        </div>
      </div>
    </main>
  );
}
