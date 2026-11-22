import { useCallback, useEffect, useState } from "react";

import {
  deleteDiscountRule,
  getDiscountRules,
  getGoodsList,
  saveDiscountRule,
  type AdminGoods,
  type DiscountRule,
} from "../api.js";

const TYPE_LABEL: Record<number, string> = { 1: "整单立减（元）", 2: "每件立减（元）", 3: "订单折扣（%）" };

function ruleText(r: DiscountRule): string {
  const amt = Number(r.amount);
  if (r.type === 1) return `满 ${r.quantity} 件立减 ¥${amt.toFixed(2)}`;
  if (r.type === 2) return `满 ${r.quantity} 件每件减 ¥${amt.toFixed(2)}`;
  return `满 ${r.quantity} 件打 ${(100 - amt) / 10} 折`;
}

export default function Discount() {
  const [goodsList, setGoodsList] = useState<AdminGoods[]>([]);
  const [goodsId, setGoodsId] = useState<number>(0);
  const [rules, setRules] = useState<DiscountRule[]>([]);
  const [error, setError] = useState("");
  const [form, setForm] = useState({ sku: "0", quantity: "2", amount: "", type: 1 });

  useEffect(() => {
    getGoodsList(1, "")
      .then((d) => setGoodsList(d.list))
      .catch((e) => setError(String(e.message)));
  }, []);

  const loadRules = useCallback((gid: number) => {
    if (!gid) return setRules([]);
    getDiscountRules(gid)
      .then(setRules)
      .catch((e) => setError(String(e.message)));
  }, []);

  useEffect(() => {
    loadRules(goodsId);
  }, [goodsId, loadRules]);

  async function submit() {
    setError("");
    try {
      await saveDiscountRule({
        goods_id: goodsId,
        sku: form.sku || "0",
        quantity: Math.max(2, Math.round(Number(form.quantity))),
        amount: Number(form.amount),
        type: form.type,
      });
      setForm({ ...form, amount: "" });
      loadRules(goodsId);
    } catch (e) {
      setError(String((e as Error).message));
    }
  }

  async function remove(id: number) {
    await deleteDiscountRule(id);
    loadRules(goodsId);
  }

  const selected = goodsList.find((g) => g.id === goodsId);

  return (
    <div>
      <h2 className="page-title">批量优惠</h2>
      <div className="toolbar">
        <select
          value={goodsId}
          onChange={(e) => setGoodsId(Number(e.target.value))}
        >
          <option value={0}>选择商品…</option>
          {goodsList.map((g) => (
            <option key={g.id} value={g.id}>
              #{g.id} {g.title}
            </option>
          ))}
        </select>
        {selected && selected.is_sku === "1" && (
          <input
            placeholder="规格 sku（单规格留 0）"
            value={form.sku}
            onChange={(e) => setForm({ ...form, sku: e.target.value })}
            style={{ width: 200 }}
          />
        )}
      </div>

      {goodsId > 0 && (
        <div className="panel">
          <h3>新增 / 覆盖规则</h3>
          <div className="form-grid">
            <label>
              类型
              <select value={form.type} onChange={(e) => setForm({ ...form, type: Number(e.target.value) })}>
                <option value={1}>{TYPE_LABEL[1]}</option>
                <option value={2}>{TYPE_LABEL[2]}</option>
                <option value={3}>{TYPE_LABEL[3]}</option>
              </select>
            </label>
            <label>
              数量门槛（≥2）
              <input
                type="number"
                min={2}
                value={form.quantity}
                onChange={(e) => setForm({ ...form, quantity: e.target.value })}
              />
            </label>
            <label>
              {form.type === 3 ? "折扣百分数（90=9折）" : "金额（元）"}
              <input
                type="number"
                min="0.01"
                step="0.01"
                value={form.amount}
                onChange={(e) => setForm({ ...form, amount: e.target.value })}
              />
            </label>
          </div>
          <button
            className="btn-primary"
            disabled={!form.amount || Number(form.quantity) < 2}
            onClick={submit}
          >
            保存规则
          </button>
          <p className="hint">下单时自动取对买家最优的一条规则应用；同商品+规格+门槛+类型将覆盖。</p>
        </div>
      )}

      {error && <p className="error">{error}</p>}
      {goodsId > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th>ID</th>
              <th>规格</th>
              <th>规则</th>
              <th>类型</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {rules.length === 0 && (
              <tr>
                <td colSpan={5} className="empty">
                  暂无规则
                </td>
              </tr>
            )}
            {rules.map((r) => (
              <tr key={r.id}>
                <td>{r.id}</td>
                <td>{r.sku === "0" ? "默认" : r.sku}</td>
                <td>{ruleText(r)}</td>
                <td>{TYPE_LABEL[r.type]}</td>
                <td>
                  <button className="btn-ghost small" onClick={() => remove(r.id)}>
                    删除
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
