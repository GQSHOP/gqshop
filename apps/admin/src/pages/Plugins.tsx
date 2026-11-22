import { useCallback, useEffect, useState } from "react";

import { getPlugins, togglePlugin, getMarket, marketInstall, marketRollback, marketUninstall, type MarketView } from "../api.js";

interface PluginRow {
  name: string;
  version: string;
  description: string;
}
interface PluginsView {
  builtin: PluginRow[];
  activated: string[];
  goods_types: Array<{ type: string; label: string; plugin: string }>;
  pay_plugins: Array<{ name: string; label: string; kind: string; plugin: string }>;
  note: string;
}

/** 插件管理（M5-γ 启停 + M6-α 应用市场：安装/升级/回滚/卸载，重启生效）。 */
export default function Plugins() {
  const [view, setView] = useState<PluginsView | null>(null);
  const [market, setMarket] = useState<MarketView | null>(null);
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(() => {
    getPlugins().then(setView).catch((e) => setError(String(e.message)));
    getMarket().then(setMarket).catch(() => setMarket(null));
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  async function marketAction(fn: () => Promise<{ msg: string }>) {
    setError(""); setMsg("");
    try { const r = await fn(); setMsg(r.msg); load(); } catch (e) { setError(String((e as Error).message)); }
  }

  async function toggle(name: string, on: boolean) {
    setError("");
    setMsg("");
    try {
      const r = await togglePlugin(name);
      setMsg(r.msg);
      load();
    } catch (e) {
      setError(String((e as Error).message));
    }
  }

  return (
    <div>
      <h2 className="page-title">插件管理</h2>
      <p className="hint">{view?.note ?? "启停写 active_plugins，重启 core 后生效（进程内模型不热加载）"}</p>
      {error && <p className="error">{error}</p>}
      {msg && <p className="hint">{msg}</p>}
      <table className="table">
        <thead>
          <tr>
            <th>插件</th>
            <th>版本</th>
            <th>说明</th>
            <th>注册贡献</th>
            <th>状态</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {(view?.builtin ?? []).map((p) => {
            const on = view?.activated.includes(p.name) ?? false;
            const goods = (view?.goods_types ?? []).filter((g) => g.plugin === p.name).map((g) => g.label);
            const pays = (view?.pay_plugins ?? []).filter((g) => g.plugin === p.name).map((g) => g.label);
            const contrib = [...goods, ...pays].join(" / ") || "—";
            return (
              <tr key={p.name}>
                <td className="mono">{p.name}</td>
                <td>{p.version}</td>
                <td>{p.description}</td>
                <td>{contrib}</td>
                <td>{on ? "✅ 已启用" : "⛔ 已停用"}</td>
                <td>
                  <button className="btn-ghost small" onClick={() => toggle(p.name, on)}>
                    {on ? "停用" : "启用"}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <h2 className="page-title" style={{ marginTop: 24 }}>应用市场</h2>
      <p className="hint">市场包经 sha256 + ed25519 双验签后落盘；安装/升级/回滚均需重启 core 生效。</p>
      {!market?.available && <p className="hint">市场源未配置（服务器 env：GQSHOP_MARKET_DIR 或 GQSHOP_MARKET_URL）。</p>}
      {market?.available && (
        <>
          {(market.upgradable ?? []).length > 0 && (
            <p className="hint">可升级：{market.upgradable.map((u) => `${u.name} ${u.from}→${u.to}`).join("；")}</p>
          )}
          <table className="table">
            <thead>
              <tr><th>插件</th><th>版本</th><th>说明</th><th>大小</th><th>已装</th><th>操作</th></tr>
            </thead>
            <tbody>
              {market.index.length === 0 && <tr><td colSpan={6} className="empty">市场为空</td></tr>}
              {market.index.map((e) => {
                const ins = market.installed.find((i) => i.name === e.name);
                const isCur = ins?.version === e.version;
                const local = market.localVersions?.[e.name] ?? [];
                return (
                  <tr key={`${e.name}-${e.version}`}>
                    <td className="mono">{e.name}</td>
                    <td>{e.version}</td>
                    <td>{e.description}</td>
                    <td>{Math.round(e.size / 1024)}KB</td>
                    <td>{ins ? (isCur ? `✅ ${ins.version}` : ins.version) : "—"}</td>
                    <td>
                      {isCur ? (
                        <>
                          <button className="btn-ghost small" onClick={() => marketAction(() => marketUninstall(e.name))}>卸载</button>
                          {local.filter((v) => v !== e.version).map((v) => (
                            <button key={v} className="btn-ghost small" onClick={() => marketAction(() => marketRollback(e.name, v))}>回滚 {v}</button>
                          ))}
                        </>
                      ) : (
                        <button className="btn-primary small" onClick={() => marketAction(() => marketInstall(e.name, e.version))}>
                          {ins ? "升级" : "安装"}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
