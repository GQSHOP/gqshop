import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";

import { api, getOrder, mockPay, type OrderView } from "../api.js";

/** 支付页（payMode）与结果页共用：按订单号展示状态/卡密。 */
export default function OrderResult({ payMode = false }: { payMode?: boolean }) {
  const { no } = useParams();
  const [order, setOrder] = useState<OrderView | null>(null);
  const [error, setError] = useState("");
  const [epayReady, setEpayReady] = useState(false);
  const [adminKey, setAdminKey] = useState(localStorage.getItem("gqshop-admin-key") ?? "");
  const [redirecting, setRedirecting] = useState(false);

  const refresh = useCallback(() => {
    if (!no) return;
    getOrder(no)
      .then(setOrder)
      .catch((e) => setError(String(e.message)));
  }, [no]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // 支付页挂载即构建网关跳转（支付类型由服务端按订单 pay_plugin 决定；未配置回退 mock 演示）
  useEffect(() => {
    if (!payMode || !no) return;
    api<{ pay_url: string }>(`/pay/epay/submit?out_trade_no=${no}`)
      .then((d) => {
        setEpayReady(true);
        setRedirecting(true);
        window.location.href = d.pay_url;
      })
      .catch(() => setEpayReady(false));
  }, [payMode, no]);

  // 未支付结果页轮询（网关异步 notify 后状态翻转，最长 120s）
  useEffect(() => {
    if (payMode || !order || order.order.pay_status === 1) return;
    const timer = setInterval(refresh, 3000);
    const stop = setTimeout(() => clearInterval(timer), 120000);
    return () => {
      clearInterval(timer);
      clearTimeout(stop);
    };
  }, [payMode, order?.order.pay_status, refresh]);

  async function doMockPay() {
    if (!no || !adminKey) return;
    localStorage.setItem("gqshop-admin-key", adminKey);
    try {
      await mockPay(no, adminKey);
      refresh();
    } catch (e) {
      setError(String((e as Error).message));
    }
  }

  if (error) return <main className="container page"><p className="empty">{error}</p></main>;
  if (!order) return <main className="container page"><p className="empty">加载中…</p></main>;

  const paid = order.order.pay_status === 1;
  const delivered = order.order.status === 2;

  return (
    <main className="container page">
      <div className="result-card">
        <h2>{delivered ? "支付成功，货已自动发货" : paid ? "支付成功，等待发货" : redirecting ? "正在跳转支付网关…" : "等待支付"}</h2>
        <p className="meta">
          订单号 <strong>{order.order.out_trade_no}</strong> · 应付 ¥
          {((order.order.amount || 0) / 100).toFixed(2)} · 下单时间{" "}
          {order.order.create_time ? new Date(Number(order.order.create_time)).toLocaleString() : "-"}
        </p>

        {!paid && payMode && !redirecting && !epayReady && (
          <div className="pay-pending">
            <p>（staging 演示）易支付未配置，可模拟网关支付（需管理密钥）：</p>
            <input
              placeholder="X-Admin-Key"
              value={adminKey}
              onChange={(e) => setAdminKey(e.target.value)}
            />
            <button className="btn-primary" onClick={doMockPay}>
              模拟支付成功
            </button>
          </div>
        )}
        {!paid && payMode && redirecting && (
          <p className="hint">
            若浏览器未自动跳转，<a href="#" onClick={(e) => { e.preventDefault(); refresh(); }}>点此刷新订单状态</a>
          </p>
        )}

        <h3>订单商品</h3>
        <ul className="items">
          {order.items.map((it, i) => (
            <li key={i}>
              {it.goods_title} × {it.quantity} = ¥{((it.price || 0) / 100).toFixed(2)}
            </li>
          ))}
        </ul>

        {delivered && (
          <>
            <h3>发货内容（卡密）</h3>
            <pre className="cards">{order.contents.join("\n\n")}</pre>
            <button
              className="btn-ghost"
              onClick={() => navigator.clipboard.writeText(order.contents.join("\n\n"))}
            >
              一键复制
            </button>
          </>
        )}

        <p className="hint">
          凭订单号 <strong>{order.order.out_trade_no}</strong> 或联系信息可随时{" "}
          <a href="/query">查询订单</a>
        </p>
      </div>
    </main>
  );
}
