import { NavLink, Navigate, Outlet, Route, Routes, useNavigate } from "react-router-dom";

import { clearToken, hasToken } from "./api.js";
import { Login } from "./Login.js";
import { Dashboard, InvitePage, LevelPage, MyOrders, Wallet, AftersalePage, StationPage, AddressPage } from "./pages.js";

const MENU = [
  { path: "/", label: "概览" },
  { path: "/wallet", label: "我的钱包" },
  { path: "/level", label: "会员等级" },
  { path: "/station", label: "我的分店" },
  { path: "/invite", label: "邀请分销" },
  { path: "/orders", label: "我的订单" },
  { path: "/aftersale", label: "售后服务" },
  { path: "/address", label: "收货地址" },
];

function RequireToken({ children }: { children: React.ReactNode }) {
  if (!hasToken()) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

/** 受保护布局：侧栏仅登录后渲染（未登录只显示独立登录页）。 */
function Layout() {
  const navigate = useNavigate();
  return (
    <div className="layout">
      <aside className="layout-side">
        <div className="side-brand">
          <span className="brand-logo">GQ</span>
          <strong>用户中心</strong>
        </div>
        <nav>
          {MENU.map((m) => (
            <NavLink key={m.path} to={m.path} end={m.path === "/"} className="side-item">
              {m.label}
            </NavLink>
          ))}
        </nav>
        <div className="side-foot">
          <a href="/" target="_blank" rel="noreferrer">逛店面前台 ↗</a>
          <button
            className="side-item logout"
            onClick={() => {
              clearToken();
              navigate("/login", { replace: true });
            }}
          >
            退出登录
          </button>
        </div>
      </aside>
      <main className="layout-main">
        <Outlet />
      </main>
    </div>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route
        element={
          <RequireToken>
            <Layout />
          </RequireToken>
        }
      >
        <Route path="/" element={<Dashboard />} />
        <Route path="/wallet" element={<Wallet />} />
        <Route path="/level" element={<LevelPage />} />
        <Route path="/station" element={<StationPage />} />
        <Route path="/invite" element={<InvitePage />} />
        <Route path="/orders" element={<MyOrders />} />
        <Route path="/aftersale" element={<AftersalePage />} />
        <Route path="/address" element={<AddressPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
