import { useCallback, useEffect, useState } from "react";

import {
  bindGoodsShipping,
  createShippingTemplate,
  getGoodsList,
  getPhysicalSales,
  getShippingTemplates,
  shipPhysicalSale,
  type AdminGoods,
  type PhysicalSale,
  type ShippingTemplate,
} from "../api.js";

/** 实物发货与运费（ADR-005 P4）。 */
export default function Physical() {
  const [templates, setTemplates] = useState<ShippingTemplate[]>([]);
  const [goodsList, setGoodsList] = useState<AdminGoods[]>([]);
  const [sales, setSales] = useState<PhysicalSale[]>([]);
  const [tab, setTab] = useState<"sales" | "tpl">("sales");
  const [error, setError] = useState("");
  const [tplForm, setTplForm] = useState({ name: "", first: "", append: "", free: "" });
  const [bindForm, setBindForm] = useState({ goodsId: 0, tplId: 0 });
  const [shipForm, setShipForm] = useState<{ id: number; company: string; no: string } | null>(null);

  const load = useCallback(() => {
    getShippingTemplates().then(setTemplates).catch((e) => setError(String(e.message)));
    getGoodsList(1, "").then((d) => setGoodsList(d.list)).catch(() => {});
    getPhysicalSales().then(setSales).catch((e) => setError(String(e.message)));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function addTpl() {
    try {
      await createShippingTemplate({
        name: tplForm.name,
        first_fee: Math.round(Number(tplForm.first) * 100),
        append_fee: Math.round(Number(tplForm.append) * 100),
        free_threshold: Math.round(Number(tplForm.free || 0) * 100),
      });
      setTplForm({ name: "", first: "", append: "", free: "" });
      load();
    } catch (e) {
      setError(String((e as Error).message));
    }
  }

  async function bind() {
    if (!bindForm.goodsId || !bindForm.tplId) return;
    await bindGoodsShipping(bindForm.goodsId, bindForm.tplId);
    setBindForm({ goodsId: 0, tplId: 0 });
    load();
  }

  async function ship() {
    if (!shipForm) return;
    try {
      await shipPhysicalSale(shipForm.id, shipForm.company, shipForm.no);
      setShipForm(null);
      load();
    } catch (e) {
      setError(String((e as Error).message));
    }
  }

  return (
    <div>
      <h2 className="page-title">实物发货</h2>
      <div className="toolbar">
        <button className={tab === "sales" ? "btn-primary" : "btn-ghost"} onClick={() => setTab("sales")}>发货单</button>
        <button className={tab === "tpl" ? "btn-primary" : "btn-ghost"} onClick={() => setTab("tpl")}>运费模板</button>
      </div>
      {error && <p className="error">{error}</p>}

      {tab === "sales" && (
        <table className="table">
          <thead>
            <tr>
              <th>ID</th><th>商品</th><th>数量</th><th>收货人</th><th>地址</th><th>订单号</th><th>物流</th><th>状态</th><th>操作</th>
            </tr>
          </thead>
          <tbody>
            {sales.length === 0 && <tr><td colSpan={9} className="empty">暂无发货单</td></tr>}
            {sales.map((s) => (
              <tr key={s.id}>
                <td>{s.id}</td>
                <td>{s.goods_title ?? `#${s.goods_id}`}</td>
                <td>{s.num}</td>
                <td>{s.receiver_name}<br /><span className="muted">{s.receiver_phone}</span></td>
                <td style={{ maxWidth: 260 }}>{s.region} {s.address}{s.buyer_remark ? <br /> : null}{s.buyer_remark && <span className="muted">备注：{s.buyer_remark}</span>}</td>
                <td className="mono">{s.out_trade_no ?? "-"}</td>
                <td>{s.logistics_company ? `${s.logistics_company} ${s.logistics_no}` : "-"}</td>
                <td>{s.status === 1 ? "✅ 已发货" : "⏳ 待发货"}</td>
                <td>
                  {s.status === 0 && (
                    <button className="btn-ghost small" onClick={() => setShipForm({ id: s.id, company: "", no: "" })}>
                      发货
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {tab === "sales" && shipForm && (
        <div className="panel">
          <h3>发货单 #{shipForm.id}</h3>
          <div className="form-grid">
            <label>
              物流公司
              <input placeholder="顺丰速运" value={shipForm.company} onChange={(e) => setShipForm({ ...shipForm, company: e.target.value })} />
            </label>
            <label>
              快递单号
              <input placeholder="SF123456789" value={shipForm.no} onChange={(e) => setShipForm({ ...shipForm, no: e.target.value })} />
            </label>
          </div>
          <button className="btn-primary" disabled={!shipForm.company || !shipForm.no} onClick={ship}>确认发货</button>
          <button className="btn-ghost" onClick={() => setShipForm(null)}>取消</button>
        </div>
      )}

      {tab === "tpl" && (
        <>
          <div className="panel">
            <h3>新增运费模板</h3>
            <div className="form-grid">
              <label>名称<input value={tplForm.name} onChange={(e) => setTplForm({ ...tplForm, name: e.target.value })} /></label>
              <label>首件运费（元）<input value={tplForm.first} onChange={(e) => setTplForm({ ...tplForm, first: e.target.value })} /></label>
              <label>续件运费（元）<input value={tplForm.append} onChange={(e) => setTplForm({ ...tplForm, append: e.target.value })} /></label>
              <label>满额包邮（元，0=不包邮）<input value={tplForm.free} onChange={(e) => setTplForm({ ...tplForm, free: e.target.value })} /></label>
            </div>
            <button className="btn-primary" disabled={!tplForm.name} onClick={addTpl}>创建</button>
          </div>
          <div className="panel">
            <h3>商品绑定模板</h3>
            <div className="form-grid">
              <label>
                商品
                <select value={bindForm.goodsId} onChange={(e) => setBindForm({ ...bindForm, goodsId: Number(e.target.value) })}>
                  <option value={0}>选择商品…</option>
                  {goodsList.map((g) => <option key={g.id} value={g.id}>#{g.id} {g.title}</option>)}
                </select>
              </label>
              <label>
                模板
                <select value={bindForm.tplId} onChange={(e) => setBindForm({ ...bindForm, tplId: Number(e.target.value) })}>
                  <option value={0}>选择模板…</option>
                  {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </label>
            </div>
            <button className="btn-primary" disabled={!bindForm.goodsId || !bindForm.tplId} onClick={bind}>绑定</button>
          </div>
          <table className="table">
            <thead><tr><th>ID</th><th>名称</th><th>首件</th><th>续件</th><th>满额包邮</th><th>状态</th></tr></thead>
            <tbody>
              {templates.map((t) => (
                <tr key={t.id}>
                  <td>{t.id}</td><td>{t.name}</td>
                  <td>¥{(t.first_fee / 100).toFixed(2)}</td>
                  <td>¥{(t.append_fee / 100).toFixed(2)}</td>
                  <td>{t.free_threshold > 0 ? `满 ¥${(t.free_threshold / 100).toFixed(2)}` : "—"}</td>
                  <td>{t.status === 1 ? "启用" : "停用"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
