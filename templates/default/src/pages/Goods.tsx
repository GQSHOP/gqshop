/**
 * M4-γ：商品详情页按 设计基线 DOM 全对齐（goods-detail-container 体系）。
 * 结构镜像设计基线 ?post=N：kami-page-header + main-card(goods-layout) +
 * spec-section + buy-form-section + pay-bar + goods-detail-section。
 * 实物商品保留地址/运费分支（ADR-005）；分店 slug 透传下单。
 */
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";

import { createOrder, getGoodsDetail, type GoodsDetail } from "../api.js";

export default function GoodsDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [goods, setGoods] = useState<GoodsDetail | null>(null);
  const [skuCode, setSkuCode] = useState<string>("");
  const [quantity, setQuantity] = useState(1);
  const [tel, setTel] = useState("");
  const [payPlugin, setPayPlugin] = useState("epay_ali");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [address, setAddress] = useState<{
    id: number;
    receiver_name: string;
    receiver_phone: string;
    region: string;
    address: string;
  } | null>(null);
  const [shippingCents, setShippingCents] = useState<number | null>(null);

  useEffect(() => {
    if (!id) return;
    getGoodsDetail(Number(id))
      .then((g) => {
        setGoods(g);
        const multi = g.skus.filter((s) => s.sku !== "0");
        if (multi[0]) setSkuCode(multi[0].code ?? "");
      })
      .catch((e) => setError(String(e.message)));
  }, [id]);

  const isPhysical = goods?.type === "goods_physical";

  // 实物：地址簿 + 运费预估
  useEffect(() => {
    if (!isPhysical) return;
    const token = localStorage.getItem("gqshop-token");
    if (token) {
      fetch("/v1/user/address", { headers: { Authorization: `Bearer ${token}` } })
        .then((r) => r.json())
        .then((d) => {
          if (d.code === 0 && d.data) setAddress(d.data);
        })
        .catch(() => {});
    }
  }, [isPhysical]);

  const unit = useMemo(() => {
    if (!goods) return 0;
    const pick = skuCode
      ? goods.skus.find((s) => s.code === skuCode) ?? goods.skus[0]
      : goods.skus[0];
    return Number(pick?.guest_price ?? pick?.market_price ?? 0);
  }, [goods, skuCode]);

  const multiSkus = useMemo(() => goods?.skus.filter((s) => s.sku !== "0") ?? [], [goods]);

  // 实物：运费预估（依赖 unit）
  useEffect(() => {
    if (!isPhysical || !goods) return;
    const subtotal = Math.round(unit * quantity);
    fetch(`/v1/shop/goods/${goods.id}/shipping-quote?quantity=${quantity}&subtotal=${subtotal}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.code === 0) setShippingCents(d.data.fee_cents ?? 0);
      })
      .catch(() => {});
  }, [isPhysical, goods, quantity, unit]);

  if (error && !goods) return <main className="goods-detail-container"><p className="empty">{error}</p></main>;
  if (!goods) return <main className="goods-detail-container"><p className="empty">加载中…</p></main>;

  async function submit() {
    if (!goods) return;
    setBusy(true);
    setError("");
    try {
      const idem = `${goods.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const order = await createOrder({
        goods_id: goods.id,
        quantity,
        tel,
        pay_plugin: payPlugin,
        idempotency_key: idem,
        address_id: isPhysical ? address?.id : undefined,
        station_slug: sessionStorage.getItem("gqshop-station") ?? undefined,
      });
      navigate(`/pay/${order.out_trade_no}`, { state: { order } });
    } catch (e) {
      setError(String((e as Error).message));
    } finally {
      setBusy(false);
    }
  }

  const total = unit * quantity + (isPhysical ? shippingCents ?? 0 : 0);
  const marketPick = skuCode
    ? goods.skus.find((s) => s.code === skuCode) ?? goods.skus[0]
    : goods.skus[0];
  const marketCents = Number(marketPick?.market_price ?? 0);

  return (
    <main className="goods-detail-container">
      <div className="kami-page-header">
        <a href="/" className="kami-back-btn"><i className="fa fa-chevron-left" /></a>
        <div className="kami-page-title">商品详情</div>
        <a href="javascript:;" className="kami-share-btn"><i className="fa fa-share-square-o" /> 分享</a>
      </div>
      <div className="kami-page-header-placeholder" />

      <div className="main-card">
        <div className="goods-layout">
          {/* 左：主图（PC cover + 移动 swiper 计数） */}
          <div className="goods-left">
            <div className="goods-cover-section">
              <div className="goods-cover-main" id="goodsCoverMain">
                <img
                  className="goods-cover-img"
                  src={goods.cover || "/gqskin/img/cover.svg"}
                  alt={goods.title}
                  data-gq-image-loaded
                />
              </div>
              <div className="goods-swiper" id="goodsSwiper">
                <div className="goods-swiper-track" id="goodsSwiperTrack">
                  <div className="goods-swiper-slide">
                    <img src={goods.cover || "/gqskin/img/cover.svg"} alt={goods.title} loading="lazy" />
                  </div>
                </div>
                <span className="goods-swiper-counter" id="goodsSwiperCounter">1/1</span>
              </div>
            </div>
          </div>

          {/* 右：信息与购买表单 */}
          <div className="goods-right">
            <div className="goods-title-section">
              <h1 className="goods-title">{goods.title}</h1>
              <div className="goods-meta">
                <span>已售：{goods.sales ?? 0}</span>
                <span>库存：<span id="goodsStock">{goods.stock ?? 0}</span></span>
              </div>
            </div>

            {multiSkus.length > 0 && (
              <div className="spec-section">
                <div className="spec-group">
                  <div className="spec-group-title">规格</div>
                  <div className="spec-options">
                    {multiSkus.map((s) => (
                      <div
                        key={s.code ?? s.sku}
                        className={"spec-option" + (skuCode === (s.code ?? "") ? " active" : "")}
                        onClick={() => setSkuCode(s.code ?? "")}
                      >
                        {s.sku}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

            <form className="buy-form-section" onSubmit={(e) => e.preventDefault()}>
              <div className="price-quantity-row">
                <div className="price-section">
                  <div className="section-label"><span className="required-star">*</span> 商品单价</div>
                  <div className="section-value">
                    <span className="unit-price" id="goodsPrice">{(unit / 100).toFixed(2)}</span>
                    <span className="unit">/{goods.unit_name ?? "个"}</span>
                    {marketCents > unit && (
                      <span className="market-price" id="goodsMarketPrice">¥{(marketCents / 100).toFixed(2)}</span>
                    )}
                  </div>
                </div>
                <div className="quantity-section">
                  <div className="section-label"><span className="required-star">*</span> 购买数量</div>
                  <div className="quantity-selector">
                    <div className="quantity-btn" onClick={() => setQuantity(Math.max(1, quantity - 1))}>－</div>
                    <input
                      type="number"
                      className="quantity-input"
                      value={quantity}
                      min={1}
                      onChange={(e) => setQuantity(Math.max(1, Math.min(999, Number(e.target.value) || 1)))}
                    />
                    <div className="quantity-btn" onClick={() => setQuantity(Math.min(999, quantity + 1))}>＋</div>
                  </div>
                </div>
              </div>

              <div className="input-field-row">
                <div className="input-field-header">
                  <div className="section-label"><span className="required-star">*</span> 联系信息</div>
                  <input
                    type="text"
                    placeholder="请输入手机号，或字母数字组合"
                    className="input-field-input required-input"
                    value={tel}
                    onChange={(e) => setTel(e.target.value)}
                  />
                </div>
                <div className="input-field-note">联系信息是查询订单的重要凭证（必填）</div>
              </div>

              {isPhysical && (
                <div className="input-field-row">
                  <div className="section-label">收货地址（实物需登录并在用户中心维护）</div>
                  {address ? (
                    <p className="muted">
                      {address.receiver_name} {address.receiver_phone} · {address.region} {address.address}{" "}
                      <a href="/user/address" target="_blank" rel="noreferrer">修改</a>
                    </p>
                  ) : (
                    <p className="error">
                      未检测到收货地址，请先到 <a href="/user/address" target="_blank" rel="noreferrer">用户中心</a> 填写（需登录）
                    </p>
                  )}
                  {shippingCents !== null && (
                    <p className="muted">运费：{shippingCents === 0 ? "包邮" : `¥${(shippingCents / 100).toFixed(2)}`}</p>
                  )}
                </div>
              )}

              <div className="section-label" style={{ marginTop: 20 }}>
                <span className="required-star">*</span> 付款方式
              </div>
              <div className="payment-methods">
                <label className={"pay-method-item" + (payPlugin === "epay_ali" ? " active" : "")}>
                  <input type="radio" checked={payPlugin === "epay_ali"} onChange={() => setPayPlugin("epay_ali")} />
                  支付宝
                </label>
                <label className={"pay-method-item" + (payPlugin === "epay_wx" ? " active" : "")}>
                  <input type="radio" checked={payPlugin === "epay_wx"} onChange={() => setPayPlugin("epay_wx")} />
                  微信支付
                </label>
              </div>

              {error && <p className="error">{error}</p>}

              <div className="drawer-footer">
                <div className="pay-bar">
                  <div className="pay-amount">
                    应付：<span className="dynamic-price" id="totalPrice">{(total / 100).toFixed(2)} 元</span>
                    {isPhysical && shippingCents ? (
                      <span className="muted">（含运费 ¥{((shippingCents ?? 0) / 100).toFixed(2)}）</span>
                    ) : null}
                  </div>
                  <button type="button" className="pay-btn" id="submitPayBtn" disabled={busy || !tel} onClick={submit}>
                    {busy ? "下单中…" : "确认付款"}
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>
      </div>

      <section className="goods-detail-section">
        <div className="goods-detail-header">
          <span className="goods-detail-bar" />
          <span className="goods-detail-title">商品详情</span>
        </div>
        <div className="goods-detail-body" dangerouslySetInnerHTML={{ __html: goods.content ?? "" }} />
      </section>
    </main>
  );
}
