import { useState } from "react";
import { useNavigate } from "react-router-dom";

import { adminLogin, setAdminToken } from "../api.js";

const FEATURES: Array<[string, string, string]> = [
  ["订单全链路", "下单、支付、发货、售后一屏可见", "ri-shopping-bag-3-line"],
  ["资金对账", "流水、分佣、提现自动归集", "ri-safe-2-line"],
  ["多分站协同", "权限、策略、结算分居下发", "ri-community-line"],
];

/** 后台登录：账号密码（dc_user role=admin）换取管理密钥。视觉对标 MKSHOP admin-ui 双栏式。 */
export default function Login() {
  const navigate = useNavigate();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    setError("");
    if (!username.trim() || !password) {
      setError("请输入账号和密码");
      return;
    }
    setBusy(true);
    try {
      const d = await adminLogin(username.trim(), password);
      setAdminToken(d.token); // M5-α：会话票制（8h），不再持有全局 key
      navigate("/", { replace: true });
    } catch (e) {
      setError(String((e as Error).message));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mk-login-page">
      <div className="mk-deco-grid" />
      <div className="mk-deco-blob mk-blob1" />
      <div className="mk-deco-blob mk-blob2" />

      <div className="mk-login-shell">
        {/* 左：品牌/价值主张 */}
        <section className="mk-brand-panel">
          <div className="mk-bp-top">
            <div className="mk-brand-mark">GQ</div>
            <div className="mk-brand-text">
              <b>GQSHOP</b>
              <span>搞钱商城 · 运营控制台</span>
            </div>
          </div>
          <div className="mk-bp-body">
            <h1 className="mk-bp-hero">
              把商品、订单、
              <br />
              资金与分站，管在一处。
            </h1>
            <p className="mk-bp-sub">
              统一处理发卡发货、支付通道、上游对接与财务对账，让运营动作更短、更稳。
            </p>
            <ul className="mk-bp-points">
              {FEATURES.map(([title, sub, icon]) => (
                <li key={title}>
                  <i className={icon} />
                  <span>
                    <b>{title}</b>
                    <em>{sub}</em>
                  </span>
                </li>
              ))}
            </ul>
          </div>
          <div className="mk-bp-foot">© 2026 GQSHOP · 自研授权系统</div>
        </section>

        {/* 右：登录表单 */}
        <section className="mk-form-panel">
          <div className="mk-form-inner">
            <h2>欢迎回来</h2>
            <p className="mk-sub">请使用管理员账号登录控制台</p>
            <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
              <div className="mk-input-row">
                <i className="ri-user-3-line mk-input-icon" />
                <input
                  placeholder="管理员账号"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                />
              </div>
              <div className="mk-input-row">
                <i className="ri-lock-password-line mk-input-icon" />
                <input
                  type="password"
                  placeholder="登录密码"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && submit()}
                />
              </div>
              {error && (
                <div className="mk-notice-strip">
                  <i className="ri-alert-line" />
                  <span>{error}</span>
                </div>
              )}
              <button className="mk-login-btn" type="submit" disabled={busy}>
                {busy ? "登录中…" : "登 录"}
              </button>
              <div className="mk-notice-strip">
                <i className="ri-alert-line" />
                <span>账号异常或忘记密码，请联系系统超级管理员重置。</span>
              </div>
            </form>
            <p className="mk-browser-hint">建议使用 Chrome / Edge 浏览器，获得最佳体验</p>
          </div>
        </section>
      </div>
    </div>
  );
}
