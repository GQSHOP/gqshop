import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

import { login, register, setToken } from "./api.js";

export function Login() {
  const navigate = useNavigate();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const storedInvite = localStorage.getItem("gqshop-invite") ??
    new URLSearchParams(window.location.search).get("invite") ?? "";
  const [invite, setInvite] = useState(storedInvite);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    setError("");
    setBusy(true);
    try {
      if (mode === "login") {
        const d = await login(username.trim(), password);
        setToken(d.token);
      } else {
        const d = await register(username.trim(), password, invite.trim() || undefined);
        const l = await login(username.trim(), password);
        setToken(l.token);
        localStorage.removeItem("gqshop-invite");
        void d;
      }
      navigate("/", { replace: true });
    } catch (e) {
      setError(String((e as Error).message));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-wrap">
      <div className="login-card">
        <div className="brand-logo">GQ</div>
        <h2>GQSHOP 用户中心</h2>
        <input placeholder="用户名" value={username} onChange={(e) => setUsername(e.target.value)} />
        <input
          type="password"
          placeholder="密码（≥6 位）"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />
        {mode === "register" && (
          <input placeholder="邀请码（选填）" value={invite} onChange={(e) => setInvite(e.target.value)} />
        )}
        {error && <p className="error">{error}</p>}
        <button className="btn-primary" onClick={submit} disabled={busy || !username || !password}>
          {mode === "login" ? "登录" : "注册并登录"}
        </button>
        <p className="muted">
          {mode === "login" ? (
            <>没有账号？<a onClick={() => setMode("register")}>去注册</a></>
          ) : (
            <>已有账号？<a onClick={() => setMode("login")}>去登录</a></>
          )}
        </p>
      </div>
    </div>
  );
}
