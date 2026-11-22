import { useCallback, useEffect, useState } from "react";

import { getGoodsList, getStockDetail, importCards, type AdminGoods, type StockDetail } from "../api.js";

export default function Stock() {
  const [goodsList, setGoodsList] = useState<AdminGoods[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [detail, setDetail] = useState<StockDetail | null>(null);
  const [cardsText, setCardsText] = useState("");
  const [sku, setSku] = useState("0");
  const [msg, setMsg] = useState("");

  useEffect(() => {
    getGoodsList(1)
      .then((d) => setGoodsList(d.list))
      .catch((e) => setMsg(String(e.message)));
  }, []);

  const loadDetail = useCallback((id: number) => {
    getStockDetail(id)
      .then(setDetail)
      .catch((e) => setMsg(String(e.message)));
  }, []);

  async function doImport() {
    if (!selected) return;
    const cards = cardsText
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (cards.length === 0) {
      setMsg("请粘贴卡密（每行一条）");
      return;
    }
    setMsg("导入中…");
    try {
      const r = await importCards(selected, sku, cards);
      setMsg(`成功导入 ${r.added} 条`);
      setCardsText("");
      loadDetail(selected);
    } catch (e) {
      setMsg(String((e as Error).message));
    }
  }

  return (
    <div>
      <h2 className="page-title">库存管理</h2>
      <div className="toolbar">
        <select
          value={selected ?? ""}
          onChange={(e) => {
            const id = Number(e.target.value);
            setSelected(id || null);
            if (id) loadDetail(id);
          }}
        >
          <option value="">选择商品…</option>
          {goodsList.map((g) => (
            <option key={g.id} value={g.id}>
              #{g.id} {g.title}
            </option>
          ))}
        </select>
      </div>

      {msg && <p className="hint">{msg}</p>}

      {detail && (
        <>
          <div className="panel">
            <h3>
              {detail.goods.title} —{" "}
              {detail.goods.type === "goods_once"
                ? "一卡一密"
                : detail.goods.type === "goods_general"
                  ? "通用卡密"
                  : "虚拟服务"}
            </h3>
            <p className="muted">
              goods.stock = {detail.goods.stock} ·{" "}
              {detail.goods.type === "goods_once"
                ? `剩余未售卡密 ${detail.counts.once_remaining}`
                : detail.goods.type === "goods_general"
                  ? `卡池内容条数 ${detail.counts.general_pool}`
                  : `服务内容条数 ${detail.counts.service_rows}`}
            </p>
          </div>
          <div className="panel">
            <h3>导入卡密</h3>
            <label className="muted">SKU 标识（单规格保持 '0'）</label>
            <input value={sku} onChange={(e) => setSku(e.target.value)} />
            <textarea
              rows={6}
              placeholder="每行一条卡密内容"
              value={cardsText}
              onChange={(e) => setCardsText(e.target.value)}
            />
            <button className="btn-primary" onClick={doImport}>
              批量导入
            </button>
          </div>
        </>
      )}
    </div>
  );
}
