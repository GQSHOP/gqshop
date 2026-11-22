import { Outlet, useNavigate } from "react-router-dom";

import { clearAdminSession, getAdminToken } from "./api.js";

const MENU = [
  { path: "/", label: "仪表盘", icon: "📊" },
  { path: "/goods", label: "商品管理", icon: "🛍" },
  { path: "/discount", label: "批量优惠", icon: "🏷" },
  { path: "/stock", label: "库存管理", icon: "📦" },
  { path: "/orders", label: "订单管理", icon: "🧾" },
  { path: "/aftersale", label: "售后工单", icon: "🎧" },
  { path: "/stations", label: "分店管理", icon: "🏪" },
  { path: "/physical", label: "实物发货", icon: "🚚" },
  { path: "/blog", label: "博客管理", icon: "✍️" },
  { path: "/groups", label: "用户组", icon: "🔐" },
  { path: "/templates", label: "模板", icon: "🎨" },
  { path: "/plugins", label: "插件", icon: "🔌" },
];

export default function Layout() {
  const navigate = useNavigate();
  const token = getAdminToken();
  // 会话票 payload 第二段 base64url 解出用户名（仅展示；无敏感信息）
  let sessionUser = "";
  try {
    const payload = JSON.parse(atob((token.split(".")[1] ?? "").replace(/-/g, "+").replace(/_/g, "/")));
    sessionUser = String(payload.username ?? "");
  } catch {
    sessionUser = "";
  }
  return (
    <div className="layout">
      <aside className="layout-side">
        <div className="side-brand">
          <span className="brand-logo">GQ</span>
          <strong>管理后台</strong>
        </div>
        <nav>
          {MENU.map((m) => (
            <button key={m.path} className="side-item" onClick={() => navigate(m.path)}>
              <span>{m.icon}</span> {m.label}
            </button>
          ))}
        </nav>
        <div className="side-foot">
          <a href="/" target="_blank" rel="noreferrer">
            打开店面前台 ↗
          </a>
          <button
            className="side-item logout"
            onClick={() => {
              clearAdminSession();
              navigate("/login", { replace: true });
            }}
          >
            退出登录{sessionUser ? `（${sessionUser}）` : ""}
          </button>
        </div>
      </aside>
      <main className="layout-main">
        <Outlet />
      </main>
    </div>
  );
}
