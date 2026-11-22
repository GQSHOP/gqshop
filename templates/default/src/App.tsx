import { useEffect, useState } from "react";
import { Route, Routes } from "react-router-dom";

import { getStationContext } from "./api.js";
import Home from "./pages/Home.js";
import GoodsDetail from "./pages/Goods.js";
import OrderResult from "./pages/Result.js";
import OrderQuery from "./pages/Query.js";
import { BlogDetail, BlogList } from "./pages/Blog.js";

export default function App() {
  // 邀请链路：/?invite=CODE 捕获并暂存，用户中心注册时自动带出
  const [station, setStation] = useState<{ name: string; title: string; site_subtitle: string; home_notice: string; slug: string } | null>(null);
  // header 搜索展开态（上游 .search-active class 语义，React 状态驱动）
  const [searchOpen, setSearchOpen] = useState(false);
  const [q, setQ] = useState("");
  useEffect(() => {
    const invite = new URLSearchParams(window.location.search).get("invite");
    if (invite) {
      localStorage.setItem("gqshop-invite", invite.toUpperCase().slice(0, 16));
    }
    // 分店态：/?s=slug 或 sessionStorage 记忆（分店内页跳转保持）
    const slug = new URLSearchParams(window.location.search).get("s") ?? sessionStorage.getItem("gqshop-station");
    if (slug) {
      const safeSlug = slug.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 50);
      sessionStorage.setItem("gqshop-station", safeSlug);
      if (safeSlug) {
        getStationContext(safeSlug)
          .then(setStation)
          .catch(() => {});
      }
    }
  }, []);

  function submitSearch() {
    window.location.href = q.trim() ? `/?q=${encodeURIComponent(q.trim())}` : "/";
  }

  return (
    <div className="app">
      <header className="header">
        <div className="h-fix">
          <div className="container">
            <h1 className="logo-brand">
              <a href="/">
                <span className="brand-logo">GQ</span>
                <div className="brand-text">
                  <span className="brand-title">{station ? station.title : "GQSHOP 搞钱商城"}</span>
                  <span className="brand-subtitle">{station ? station.site_subtitle || "订单问题请查看买家帮助" : "订单问题请查看买家帮助"}</span>
                </div>
              </a>
            </h1>
            <div className="nav-container">
              <nav className="nav-bar" id="nav-box">
                <ul className="nav">
                  <li className="active">
                    <a href="/"><i className="ri-home-4-line" style={{ marginRight: 5 }} /> 首页</a>
                  </li>
                  <li>
                    <a href="/blog"><i className="ri-article-line" style={{ marginRight: 5 }} /> 博客</a>
                  </li>
                </ul>
              </nav>
            </div>
            <div className="header-right">
              <div className="header-right-btn">
                <div className={"search" + (searchOpen ? " search-active" : "")}>
                  <i
                    className="s-btn fa fa-search"
                    style={{ display: searchOpen ? "none" : "block" }}
                    onClick={() => setSearchOpen(true)}
                  />
                  <form
                    className="header-search-expand"
                    onSubmit={(e) => {
                      e.preventDefault();
                      submitSearch();
                    }}
                  >
                    <input
                      type="text"
                      name="q"
                      className="header-search-input"
                      placeholder="搜索商品"
                      value={q}
                      onChange={(e) => setQ(e.target.value)}
                    />
                    <button type="submit" className="header-search-submit"><i className="fa fa-search" /></button>
                  </form>
                  <i className="fa fa-times header-search-close" onClick={() => setSearchOpen(false)} />
                </div>
                <div className="header-user">
                  <a href="/user/"><i className="fa fa-user" /></a>
                </div>
                <div className="header-search-order-btn">
                  <a href="/query" className="a transition">查询订单</a>
                </div>
              </div>
            </div>
          </div>
        </div>
      </header>

      {station && station.home_notice && (
        <div className="container">
          <p className="station-notice">{station.home_notice}</p>
        </div>
      )}
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/goods/:id" element={<GoodsDetail />} />
        <Route path="/pay/:no" element={<OrderResult payMode />} />
        <Route path="/result/:no" element={<OrderResult />} />
        <Route path="/query" element={<OrderQuery />} />
        <Route path="/blog" element={<BlogList />} />
        <Route path="/blog/:key" element={<BlogDetail />} />
      </Routes>

      <footer className="main-footer">
        <div className="container">
          <div className="footer-content">
            <div className="footer-info">
              <div className="copyright">
                <span>
                  Powered by GQSHOP | <a style={{ color: "rgb(113 172 249)" }} href="https://github.com/GQSHOP" target="_blank" rel="noreferrer">搞钱商城系统</a> | 本程序为免费开源程序，使用者造成的一切法律后果与作者无关。
                </span>
                <span className="divider">|</span>
              </div>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
