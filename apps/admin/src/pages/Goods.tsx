import { useCallback, useEffect, useState } from "react";

import { createGoods, getGoodsList, toggleShelf, updateGoods, uploadCover, getPriceRules, savePriceRules, type AdminGoods } from "../api.js";

const TYPE_LABEL: Record<string, string> = {
  goods_once: "一卡一密",
  goods_general: "通用卡密",
  goods_service: "虚拟服务",
};

export default function Goods() {
  const [list, setList] = useState<AdminGoods[]>([]);
  const [keyword, setKeyword] = useState("");
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const [coverTarget, setCoverTarget] = useState<AdminGoods | null>(null);
  const [coverMsg, setCoverMsg] = useState("");
  const [form, setForm] = useState({ title: "", type: "goods_general", guestPrice: "", marketPrice: "", content: "", password: "", payContent: "" });
  const [secretTarget, setSecretTarget] = useState<AdminGoods | null>(null);
  const [secretForm, setSecretForm] = useState({ password: "", payContent: "" });
  const [secretMsg, setSecretMsg] = useState("");
  const [rulesOpen, setRulesOpen] = useState(false);
  const [rules, setRules] = useState({ singleYuan: "", profitYuan: "", markupPercent: "" });
  const [rulesMsg, setRulesMsg] = useState("");

  function openRules() {
    setRulesOpen(!rulesOpen);
    setRulesMsg("");
    getPriceRules()
      .then((r) =>
        setRules({
          singleYuan: r.single_cents ? (r.single_cents / 100).toFixed(2) : "",
          profitYuan: r.profit_cents ? (r.profit_cents / 100).toFixed(2) : "",
          markupPercent: r.markup_percent ? String(r.markup_percent) : "",
        }),
      )
      .catch((e) => setRulesMsg(String(e.message)));
  }

  async function saveRules() {
    setRulesMsg("保存中…");
    try {
      const r = await savePriceRules({
        single_cents: Math.round(Number(rules.singleYuan || 0) * 100),
        profit_cents: Math.round(Number(rules.profitYuan || 0) * 100),
        markup_percent: Math.round(Number(rules.markupPercent || 0)),
      });
      setRulesMsg(r.msg);
    } catch (e) {
      setRulesMsg(String((e as Error).message));
    }
  }

  const load = useCallback((kw = "") => {
    getGoodsList(1, kw)
      .then((d) => setList(d.list))
      .catch((e) => setError(String(e.message)));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function flip(g: AdminGoods) {
    await toggleShelf(g.id, g.is_on_shelf !== 1);
    load(keyword);
  }

  async function submitCreate() {
    setError("");
    try {
      await createGoods({
        title: form.title,
        type: form.type,
        guest_price: Math.round(Number(form.guestPrice) * 100),
        market_price: Math.round(Number(form.marketPrice || form.guestPrice) * 100),
        content: form.content,
        ...(form.password ? { password: form.password } : {}),
        ...(form.payContent ? { pay_content: form.payContent } : {}),
      });
      setCreating(false);
      setForm({ title: "", type: "goods_general", guestPrice: "", marketPrice: "", content: "", password: "", payContent: "" });
      load(keyword);
    } catch (e) {
      setError(String((e as Error).message));
    }
  }

  return (
    <div>
      <h2 className="page-title">商品管理</h2>
      <div className="toolbar">
        <input
          placeholder="按标题搜索"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && load(keyword)}
        />
        <button className="btn-ghost" onClick={() => load(keyword)}>
          搜索
        </button>
        <button className="btn-primary" onClick={() => setCreating(!creating)}>
          {creating ? "取消" : "＋ 新建商品"}
        </button>
        <button className="btn-ghost" onClick={openRules}>
          定价规则
        </button>
      </div>

      {rulesOpen && (
        <div className="panel">
          <h3>高级定价规则（功能池④，0=关闭）</h3>
          <div className="form-grid">
            <label>全场统一价（元）<input value={rules.singleYuan} placeholder="如 9.90，0=关" onChange={(e) => setRules({ ...rules, singleYuan: e.target.value })} /></label>
            <label>成本+固定利润（元）<input value={rules.profitYuan} placeholder="按 SKU 成本计价，0=关" onChange={(e) => setRules({ ...rules, profitYuan: e.target.value })} /></label>
            <label>成本加成（%）<input value={rules.markupPercent} placeholder="如 30，0=关" onChange={(e) => setRules({ ...rules, markupPercent: e.target.value })} /></label>
          </div>
          <p className="muted">优先级：统一价 &gt; 会员价覆盖 &gt; 成本规则（利润优先于加成）&gt; 常规价格链；商品列表与详情同步展示规则价。</p>
          <button className="btn-primary small" onClick={saveRules}>保存</button>{" "}
          <button className="btn-ghost small" onClick={() => setRulesOpen(false)}>关闭</button>
          {rulesMsg && <p className="hint">{rulesMsg}</p>}
        </div>
      )}

      {creating && (
        <div className="panel">
          <div className="form-grid">
            <label>标题<input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></label>
            <label>
              类型
              <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
                <option value="goods_general">通用卡密</option>
                <option value="goods_once">一卡一密</option>
                <option value="goods_service">虚拟服务</option>
              </select>
            </label>
            <label>游客价（元）<input value={form.guestPrice} onChange={(e) => setForm({ ...form, guestPrice: e.target.value })} /></label>
            <label>市场价（元，划线）<input value={form.marketPrice} onChange={(e) => setForm({ ...form, marketPrice: e.target.value })} /></label>
          </div>
          <label className="block">详情 HTML<textarea rows={3} value={form.content} onChange={(e) => setForm({ ...form, content: e.target.value })} /></label>
          <div className="form-grid">
            <label>密码（可选，购买后在商品页查看）<input value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></label>
            <label>付费内容（可选，购买后可见，HTML）<textarea rows={2} value={form.payContent} onChange={(e) => setForm({ ...form, payContent: e.target.value })} /></label>
          </div>
          <button className="btn-primary" onClick={submitCreate} disabled={!form.title || !form.guestPrice}>
            创建
          </button>
        </div>
      )}

      {error && <p className="error">{error}</p>}
      {secretTarget && (
        <div className="panel">
          <h3>密码 / 付费内容：{secretTarget.title}（#{secretTarget.id}）</h3>
          <label className="block">密码（留空提交=清空）<input value={secretForm.password} onChange={(e) => setSecretForm({ ...secretForm, password: e.target.value })} /></label>
          <label className="block">付费内容 HTML（留空提交=清空）<textarea rows={3} value={secretForm.payContent} onChange={(e) => setSecretForm({ ...secretForm, payContent: e.target.value })} /></label>
          <button
            className="btn-primary"
            onClick={async () => {
              try {
                await updateGoods(secretTarget.id, { password: secretForm.password, pay_content: secretForm.payContent });
                setSecretMsg("已保存（购买者付款后可在商品页查看）");
              } catch (e) {
                setSecretMsg(String((e as Error).message));
              }
            }}
          >
            保存
          </button>{" "}
          <button className="btn-ghost" onClick={() => { setSecretTarget(null); setSecretMsg(""); }}>关闭</button>
          {secretMsg && <p className="hint">{secretMsg}</p>}
          <p className="muted">注意：仅提交勾选字段会更新；此处两项留空保存即清空该商品密码与付费内容。</p>
        </div>
      )}
      {coverTarget && (
        <div className="panel">
          <h3>设置封面：{coverTarget.title}（#{coverTarget.id}）</h3>
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (!f || !coverTarget) return;
              setCoverMsg("上传中…");
              try {
                const url = await uploadCover(f);
                await updateGoods(coverTarget.id, { cover: url });
                setCoverMsg("封面已更新：" + url);
                load(keyword);
              } catch (err) {
                setCoverMsg(String((err as Error).message));
              }
            }}
          />
          {coverMsg && <p className="hint">{coverMsg}</p>}
          <p className="muted">选择图片后自动上传并应用到商品（≤5MB，jpg/png/webp/gif/svg）</p>
        </div>
      )}
      <table className="table">
        <thead>
          <tr>
            <th>ID</th>
            <th>标题</th>
            <th>类型</th>
            <th>游客价</th>
            <th>库存</th>
            <th>销量</th>
            <th>状态</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {list.map((g) => (
            <tr key={g.id}>
              <td>{g.id}</td>
              <td>{g.title}</td>
              <td>{TYPE_LABEL[g.type] ?? g.type}</td>
              <td>¥{((Number(g.min_price) || 0) / 100).toFixed(2)}</td>
              <td>{g.stock}</td>
              <td>{g.sales}</td>
              <td>{g.is_on_shelf === 1 ? "在售" : "下架"}</td>
              <td>
                <button className="btn-ghost small" onClick={() => { setCoverTarget(g); setCoverMsg(""); }}>
                  封面
                </button>{" "}
                <button className="btn-ghost small" onClick={() => { setSecretTarget(g); setSecretForm({ password: "", payContent: "" }); setSecretMsg(""); }}>
                  密码/付费
                </button>
                {" "}
                <button className="btn-ghost small" onClick={() => flip(g)}>
                  {g.is_on_shelf === 1 ? "下架" : "上架"}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
