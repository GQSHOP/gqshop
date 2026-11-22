/**
 * M5-β 极简模板（切换链验收）：列表 → 详情 → 下单（余额/mock 提示）。
 * 自洽购物流，不依赖 dcskin；样式内联于 index.html。
 */
import { useEffect, useState } from "react";
import { Link, Route, Routes, useParams, useSearchParams } from "react-router-dom";

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch("/v1" + path, {
    headers: { "content-type": "application/json", ...(init?.headers as Record<string, string> | undefined) },
    ...init,
  });
  const body = (await res.json()) as { code: number; msg: string; data?: T };
  if (body.code !== 0) throw new Error(body.msg || `API ${body.code}`);
  return body.data as T;
}

interface GoodsCard {
  id: number;
  title: string;
  cover: string | null;
  stock: number | null;
  sales: number | null;
  unit_name: string | null;
  min_price: string | number | null;
  type: string | null;
}
interface Sku {
  code: string | null;
  sku: string;
  guest_price: number | null;
  market_price: number | null;
  stock: number | null;
}
interface GoodsDetail extends GoodsCard {
  content: string | null;
  skus: Sku[];
}

function fen(y: string | number | null | undefined): string {
  return ((Number(y) || 0) / 100).toFixed(2);
}

function Home() {
  const [list, setList] = useState<GoodsCard[]>([]);
  const [kw, setKw] = useState("");
  useEffect(() => {
    api<{ list: GoodsCard[] }>(`/shop/goods?sort_id=0&keyword=${encodeURIComponent(kw)}`)
      .then((d) => setList(d.list))
      .catch(() => {});
  }, [kw]);
  return (
    <main>
      <input placeholder="搜索商品…" value={kw} onChange={(e) => setKw(e.target.value)} />
      {list.length === 0 && <div className="card">暂无商品</div>}
      {list.map((g) => (
        <Link to={`/goods/${g.id}`} key={g.id} style={{ textDecoration: "none", color: "inherit" }}>
          <div className="card goods">
            <div>
              <div>{g.title}</div>
              <div className="meta">
                库存 {g.stock ?? 0} · 已售 {g.sales ?? 0} · {g.type === "goods_service" ? "人工" : "自动"}
              </div>
            </div>
            <div className="price">
              ¥{fen(g.min_price)}/{g.unit_name ?? "个"}
            </div>
          </div>
        </Link>
      ))}
    </main>
  );
}

function Goods() {
  const { id } = useParams();
  const [g, setG] = useState<GoodsDetail | null>(null);
  const [sku, setSku] = useState("");
  const [qty, setQty] = useState(1);
  const [tel, setTel] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<GoodsDetail>(`/shop/goods/${id}`)
      .then((d) => {
        setG(d);
        setSku(d.skus[0]?.sku ?? "0");
      })
      .catch((e) => setMsg(String((e as Error).message)));
  }, [id]);

  async function order() {
    if (!g) return;
    setBusy(true);
    setMsg("");
    try {
      const d = await api<{ out_trade_no: string; amount: number }>("/shop/orders", {
        method: "POST",
        body: JSON.stringify({
          goods_id: g.id,
          sku_code: sku,
          quantity: qty,
          tel,
          pay_plugin: "epay_wx",
          idempotency_key: `min-${g.id}-${Date.now()}`,
        }),
      });
      setMsg(`下单成功 ¥${fen(d.amount)} · 单号 ${d.out_trade_no}，请前往支付页完成支付`);
    } catch (e) {
      setMsg(String((e as Error).message));
    } finally {
      setBusy(false);
    }
  }

  if (!g) return <main>{msg && <div className="msg">{msg}</div>}</main>;
  return (
    <main>
      <Link to="/" className="back">
        ← 返回列表
      </Link>
      <div className="card">
        <h2>{g.title}</h2>
        <div className="meta">
          库存 {g.stock ?? 0} · 已售 {g.sales ?? 0}
        </div>
      </div>
      <div className="card">
        {g.skus.length > 1 && (
          <select value={sku} onChange={(e) => setSku(e.target.value)}>
            {g.skus.map((s) => (
              <option key={s.sku} value={s.sku}>
                {s.sku}（¥{fen(s.guest_price ?? s.market_price)}）
              </option>
            ))}
          </select>
        )}
        <input type="number" min={1} max={999} value={qty} onChange={(e) => setQty(Number(e.target.value) || 1)} />
        <input placeholder="联系方式（选填）" value={tel} onChange={(e) => setTel(e.target.value)} />
        <button className="primary" disabled={busy} onClick={order}>
          {busy ? "下单中…" : `立即下单 ¥${fen(g.min_price)}`}
        </button>
        {msg && <div className="msg">{msg}</div>}
      </div>
      {g.content && <div className="card" dangerouslySetInnerHTML={{ __html: g.content }} />}
    </main>
  );
}

function Query() {
  const [sp] = useSearchParams();
  const [no, setNo] = useState(sp.get("no") ?? "");
  const [data, setData] = useState<{ order: { out_trade_no: string; amount: number; pay_status: number; status: number }; contents: string[] } | null>(null);
  const [msg, setMsg] = useState("");
  async function q() {
    setMsg("");
    setData(null);
    try {
      setData(await api(`/shop/orders/${no.trim()}`));
    } catch (e) {
      setMsg(String((e as Error).message));
    }
  }
  return (
    <main>
      <div className="card">
        <h2>订单查询</h2>
        <input placeholder="订单号" value={no} onChange={(e) => setNo(e.target.value)} />
        <button className="primary" onClick={q}>
          查询
        </button>
        {msg && <div className="msg">{msg}</div>}
        {data && (
          <div className="msg">
            {data.order.out_trade_no} · ¥{fen(data.order.amount)} · {data.order.pay_status === 1 ? "已支付" : "未支付"}
            {data.contents.length > 0 && (
              <div style={{ marginTop: 8, whiteSpace: "pre-wrap" }}>{data.contents.join("\n")}</div>
            )}
          </div>
        )}
      </div>
    </main>
  );
}

export default function App() {
  return (
    <div>
      <header>
        <strong>GQSHOP · 极简模板</strong>
        <Link to="/query">订单查询</Link>
      </header>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/goods/:id" element={<Goods />} />
        <Route path="/query" element={<Query />} />
      </Routes>
    </div>
  );
}
