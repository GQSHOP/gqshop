import { useCallback, useEffect, useState } from "react";

import { createGoods, getGoodsList, toggleShelf, updateGoods, uploadCover, type AdminGoods } from "../api.js";

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
  const [form, setForm] = useState({ title: "", type: "goods_general", guestPrice: "", marketPrice: "", content: "" });

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
      });
      setCreating(false);
      setForm({ title: "", type: "goods_general", guestPrice: "", marketPrice: "", content: "" });
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
      </div>

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
          <button className="btn-primary" onClick={submitCreate} disabled={!form.title || !form.guestPrice}>
            创建
          </button>
        </div>
      )}

      {error && <p className="error">{error}</p>}
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
