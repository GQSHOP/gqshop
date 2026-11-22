/**
 * M4-α/β：按 设计基线 DOM 全对齐重写（ADR-007 V1/V2）。
 * 结构镜像 src/dcskin/ref/home.html：banner 轮播 + notice-card + vticker +
 * 快捷分类 + dc-category-sidebar + fk-filter-bar + goods-list-section。
 * 交互（轮播自滚/vticker/滤条/搜索）React 实现，不引 jQuery。
 * 数据：dc_options.roll_bulletin/home_bulletin 为 β 接线点，本文件暂用设计基线同款静态文案。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";

import { getCategories, getGoods, getSiteOptions, type Category, type GoodsCard, type GoodsSort } from "../api.js";

/* ---------- 快捷分类 fallback（分类未配 sorticon 时轮询） ---------- */
const CAT_FALLBACK: Array<[string, string]> = [
  ["ri-money-cny-circle-line", "#ff6600"],
  ["ri-gamepad-line", "#2196F3"],
  ["ri-vip-crown-line", "#ff9800"],
  ["ri-key-2-line", "#4caf50"],
  ["ri-movie-line", "#e91e63"],
  ["ri-gift-line", "#9c27b0"],
  ["ri-smartphone-line", "#00bcd4"],
  ["ri-coupon-line", "#ff5722"],
  ["ri-service-line", "#607d8b"],
  ["ri-book-open-line", "#795548"],
  ["ri-computer-line", "#3f51b5"],
  ["ri-apps-2-line", "#999999"],
];

const BANNERS: Array<{ title: string; sub: string }> = [
  { title: "GQSHOP 搞钱商城", sub: "7×24 小时全自动发货 · 下单即时收货" },
  { title: "虚拟商品·一键开店", sub: "分店多租户 · 会员价格链 · 批量优惠" },
  { title: "安全便捷的数字交易", sub: "微信 / 支付宝 / 余额多种支付方式" },
];

const NOTICE_FALLBACK = [
  "欢迎来到 GQSHOP 搞钱商城，本程序为免费开源程序，使用者造成的一切法律后果与作者无关。",
  "本站全部商品 7×24 小时全自动发货，下单即时收货",
  "平台支持微信、支付宝、余额多种支付方式，安全便捷",
  "注册即享会员价，下单越多等级越高，拿货成本更低",
  "请勿轻信任何要求私下转账的客服，所有交易请通过本站完成",
];

const HOME_BULLETIN_FALLBACK = `<p style="margin:0 0 10px;line-height:1.85;color:#333;font-size:14px;"><i class="ri-megaphone-line" style="color:#ff6600;margin-right:6px;font-size:16px;"></i><strong>欢迎来到 GQSHOP 搞钱商城！</strong> 此程序为免费开源程序搭建，全部商品 <strong>7×24 小时全自动发货</strong>，下单即时收货。</p><p style="margin:0 0 10px;line-height:1.85;color:#333;font-size:14px;"><i class="ri-vip-crown-line" style="color:#ff9800;margin-right:6px;font-size:16px;"></i>内置 <strong>8 档现成会员等级方案</strong>，不满足需求可自定义无限添加，灵活搭建会员体系。</p><p style="margin:0;line-height:1.85;color:#333;font-size:14px;"><i class="ri-store-line" style="color:#2196F3;margin-right:6px;font-size:16px;"></i>分店系统支持独立域名开店，<strong>批量优惠、完善售后与多端自适应</strong>购物体验，让虚拟商品交易更高效、更安心。</p>`;

/* ---------- 轮播（React 实现 data-speed=3000 slide） ---------- */
function Banner() {
  const [idx, setIdx] = useState(0);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const go = useCallback((n: number) => setIdx((p) => (n + BANNERS.length) % BANNERS.length), []);
  useEffect(() => {
    timer.current = setInterval(() => setIdx((p) => (p + 1) % BANNERS.length), 3000);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, []);
  return (
    <div className="fk-banner-wrap">
      <div className="fk-banner" id="fk-banner" style={{ height: 270 }}>
        <div
          className="fk-banner-track"
          id="fk-banner-track"
          data-speed="3000"
          data-anim="slide"
          style={{ transform: `translateX(-${idx * 100}%)`, transition: "transform .5s" }}
        >
          {BANNERS.map((b) => (
            <div className="fk-banner-slide gq-banner-text" key={b.title}>
              <div className="gq-banner-inner">
                <div className="gq-banner-title">{b.title}</div>
                <div className="gq-banner-sub">{b.sub}</div>
              </div>
            </div>
          ))}
        </div>
        <div className="fk-banner-dots" id="fk-banner-dots">
          {BANNERS.map((_, i) => (
            <button key={i} className={"fk-banner-dot" + (i === idx ? " active" : "")} data-idx={i} onClick={() => go(i)} />
          ))}
        </div>
        <button className="fk-banner-arrow fk-banner-prev" onClick={() => go(idx - 1)}>‹</button>
        <button className="fk-banner-arrow fk-banner-next" onClick={() => go(idx + 1)}>›</button>
      </div>
    </div>
  );
}

/* ---------- 滚动公告 vticker（纵向逐条，dc_options.roll_bulletin 接线） ---------- */
function RollNotice({ items }: { items: string[] }) {
  const list = items.length > 0 ? items : NOTICE_FALLBACK;
  const [row, setRow] = useState(0);
  useEffect(() => {
    if (list.length <= 1) return;
    const t = setInterval(() => setRow((p) => (p + 1) % list.length), 3000);
    return () => clearInterval(t);
  }, [list.length]);
  return (
    <div className="roll-notice-bar">
      <i className="layui-icon">&#xe667;</i>
      <div className="roll-notice-vticker js-vticker">
        {/* 每行 20px（.roll-notice-vitem 高度）——百分比基准是 track 自身总高，会整轨跳空 */}
        <div className="js-vtrack" style={{ transform: `translateY(-${row * 20}px)`, transition: "transform .4s" }}>
          {list.map((n, i) => (
            <div className="roll-notice-vitem" key={i}>{n}</div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ---------- 页面 ---------- */
export default function Home() {
  const [categories, setCategories] = useState<Category[]>([]);
  const [goods, setGoods] = useState<GoodsCard[]>([]);
  const [activeSort, setActiveSort] = useState(0);
  const [keyword, setKeyword] = useState(() => new URLSearchParams(window.location.search).get("q") ?? "");
  const [sortMode, setSortMode] = useState<GoodsSort>("default");
  const [totalCount, setTotalCount] = useState(0);
  // 公告接线（M4 收尾）：dc_options.roll_bulletin（换行多条）/home_bulletin（HTML）
  const [noticeItems, setNoticeItems] = useState<string[]>([]);
  const [homeBulletin, setHomeBulletin] = useState("");

  useEffect(() => {
    getCategories()
      .then((cs) => {
        setCategories(cs);
        setTotalCount(cs.reduce((a, c) => a + Number((c as { count?: number }).count ?? 0), 0));
      })
      .catch(() => {});
    getSiteOptions()
      .then((o) => {
        const rolls = (o.roll_bulletin ?? "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
        if (rolls.length > 0) setNoticeItems(rolls);
        if (o.home_bulletin) setHomeBulletin(o.home_bulletin);
      })
      .catch(() => {});
  }, []);

  const load = useCallback(() => {
    getGoods(activeSort, 1, keyword, sortMode).then((d) => setGoods(d.list)).catch(() => {});
  }, [activeSort, keyword, sortMode]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <main className="blog-container">
      {/* 顶部：左轮播 + 右公告卡（上游 fk-hero-row 双列） */}
      <div className="fk-hero-row">
        <Banner />
        <div className="fk-notice-col">
          <div className="notice-card">
            <div className="notice-card-header">
              <i className="layui-icon">&#xe667;</i>
              <span>网站公告</span>
            </div>
            <div className="notice-card-content" dangerouslySetInnerHTML={{ __html: homeBulletin || HOME_BULLETIN_FALLBACK }} />
          </div>
        </div>
      </div>
      <RollNotice items={noticeItems} />

      {/* 快捷分类（dc_sort 数据驱动：sorticon 优先，未配置按序 fallback） */}
      <div className="category-section ci-has-pager">
        <div className="ci-slide-wrapper">
          <button type="button" className="ci-slide-arrow ci-slide-prev" title="向左">‹</button>
          <div className="category-grid slide-mode ci-desktop-grid" id="ci-slide-track">
            {categories.map((c, i) => {
              const [fbIcon = "ri-apps-2-line", fbColor = "#999999"] = CAT_FALLBACK[i % CAT_FALLBACK.length] ?? [];
              const icon = c.sorticon?.trim() || fbIcon;
              return (
                <a className="category-item" key={c.sid} onClick={() => setActiveSort(c.sid)}>
                  <div className="category-icon">
                    <i className={icon} style={{ color: fbColor }} />
                  </div>
                  <span>{c.sortname}</span>
                </a>
              );
            })}
          </div>
          <button type="button" className="ci-slide-arrow ci-slide-next" title="向右">›</button>
        </div>
      </div>

      {/* 侧栏 + 商品区（上游 dc-category-product-content 双列包裹层） */}
      <div className="dc-category-product-content">
      <aside className="dc-category-sidebar">
        <div className="dc-category-sidebar__title">商品分类</div>
        <div className="dc-category-sidebar__scroll">
          <ul className="dc-category-sidebar__list">
            <li className={"dc-category-sidebar__item" + (activeSort === 0 ? " is-expanded" : "")}>
              <a className="dc-category-sidebar__link" onClick={() => setActiveSort(0)}>
                <span className="dc-category-sidebar__row">
                  <span className="dc-category-sidebar__name">全部商品</span>
                  <span className="dc-category-sidebar__count">{totalCount}</span>
                </span>
              </a>
            </li>
            {categories.map((c) => (
              <li key={c.sid} className={"dc-category-sidebar__item" + (activeSort === c.sid ? " is-expanded" : "")}>
                <a className="dc-category-sidebar__link" onClick={() => setActiveSort(c.sid)}>
                  <span className="dc-category-sidebar__row">
                    <span className="dc-category-sidebar__name">{c.sortname}</span>
                    <span className="dc-category-sidebar__count">{c.count ?? ""}</span>
                  </span>
                </a>
              </li>
            ))}
          </ul>
        </div>
      </aside>

      <section className="goods-area">
        <div className="fk-filter-bar">
          <a className={"fk-filter-chip" + (sortMode === "default" ? " active" : "")} onClick={() => setSortMode("default")}><i className="ri-apps-2-line fk-chip-ri" />综合</a>
          <a className={"fk-filter-chip" + (sortMode === "sales" ? " active" : "")} onClick={() => setSortMode("sales")}><i className="ri-fire-line fk-chip-ri" />销量</a>
          <a className={"fk-filter-chip" + (sortMode === "price" ? " active" : "")} onClick={() => setSortMode("price")}><i className="ri-price-tag-3-line fk-chip-ri" />价格</a>
          <a className={"fk-filter-chip" + (sortMode === "stock" ? " active" : "")} onClick={() => setSortMode("stock")}><i className="ri-stack-line fk-chip-ri" />库存</a>
          <div className="dc-goods-search">
            <input
              className="dc-goods-search__input"
              placeholder="输入商品关键词搜索"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && load()}
            />
            <button className="dc-goods-search__submit" onClick={() => load()}>
              <i className="ri-search-line" />
            </button>
          </div>
        </div>
        <div className="goods-list-section" id="fk-goods-list-section">
          <div className="goods-grid goods-grid-layout-list goods-grid-list">
            {goods.map((g, i) => (
              <div
                className="goods-grid-item layui-anim layui-anim-scaleSpring"
                style={{ animationDelay: `${i * 0.05}s` }}
                key={g.id}
              >
                <Link className="goods-card" to={`/goods/${g.id}`} title={g.title}>
                  <div className="goods-img-box">
                    <img
                      className="goods-img"
                      src={g.cover || "/dcskin/img/cover.svg"}
                      alt={g.title}
                      loading="lazy"
                      data-dc-image-loaded
                    />
                    <span className={"fk-type-badge " + (g.type === "goods_service" ? "fk-tb-orange" : "fk-tb-blue")}>
                      {g.type === "goods_service" ? "人工服务" : "自动发货"}
                    </span>
                  </div>
                  <div className="goods-info">
                    <div className="goods-title row-2-hidden">{g.title}</div>
                    <div className="goods-meta">
                      <span className="goods-meta-stock">库存 {g.stock ?? 0}</span>
                      <span style={{ color: "#ddd" }}>·</span>
                      <span className="goods-meta-sales">已售 {g.sales ?? 0}</span>
                    </div>
                    <div className="goods-price-row">
                      <div className="price-wrap">
                        <span className="price-current">
                          <small>¥</small>
                          {((Number(g.min_price) || 0) / 100).toFixed(2)}
                        </span>
                        <span className="unit">/{g.unit_name ?? "个"}</span>
                      </div>
                      <div className="goods-buy-btn"><i className="ri-shopping-cart-2-line" /></div>
                    </div>
                  </div>
                </Link>
              </div>
            ))}
            {goods.length === 0 && <p className="empty">暂无商品</p>}
          </div>
        </div>
      </section>
      </div>
    </main>
  );
}
