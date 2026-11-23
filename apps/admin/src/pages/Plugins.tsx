import { useCallback, useEffect, useState } from "react";

import {
  getPlugins, togglePlugin, getMarket, marketInstall, marketRollback, marketUninstall,
  getPluginConfig, savePluginConfig, importMarketLicense,
  type MarketView, type PluginConfigField, type PluginConfigValue,
} from "../api.js";

interface PluginRow {
  name: string;
  version: string;
  description: string;
  has_config?: boolean;
}
interface PluginsView {
  builtin: PluginRow[];
  /** 市场安装且当前激活的外部插件（v1.3.x：可启停/可配置） */
  external?: PluginRow[];
  activated: string[];
  goods_types: Array<{ type: string; label: string; plugin: string }>;
  pay_plugins: Array<{ name: string; label: string; kind: string; plugin: string }>;
  note: string;
}

/** v1.2.0 插件配置编辑器（schema 驱动泛化表单；事件类插件即读即用，无需重启）。 */
function ConfigEditor({ name, onDone }: { name: string; onDone: (m: string) => void }) {
  const [schema, setSchema] = useState<PluginConfigField[]>([]);
  const [values, setValues] = useState<Record<string, PluginConfigValue | string>>({});
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    getPluginConfig(name)
      .then((d) => {
        setSchema(d.schema);
        setValues({ ...d.values });
      })
      .catch((e) => setError(String((e as Error).message)));
  }, [name]);

  async function save() {
    setSaving(true); setError(""); setMsg("");
    try {
      // boolean 缺省=false；其余按现值提交（后端白名单+类型强制）
      const out: Record<string, PluginConfigValue> = {};
      for (const f of schema) {
        const v = values[f.key];
        if (f.type === "boolean") out[f.key] = v === true || v === "true";
        else if (v !== undefined && v !== "") out[f.key] = v;
      }
      const r = await savePluginConfig(name, out);
      setMsg(r.msg);
      setTimeout(() => onDone(r.msg), 800);
    } catch (e) {
      setError(String((e as Error).message));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ border: "1px solid var(--line, #e5e7eb)", borderRadius: 8, padding: "12px 16px", margin: "12px 0" }}>
      <h3 className="section-title" style={{ marginBottom: 8 }}>配置：{name}</h3>
      {error && <p className="error">{error}</p>}
      {msg && <p className="hint">{msg}</p>}
      <div style={{ display: "grid", gap: 10, maxWidth: 560 }}>
        {schema.map((f) => (
          <label key={f.key} style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ width: 160, flexShrink: 0 }}>{f.label}</span>
            {f.type === "boolean" ? (
              <input
                type="checkbox"
                checked={values[f.key] === true || values[f.key] === "true"}
                onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.checked }))}
              />
            ) : (
              <input
                className="input" style={{ flex: 1 }}
                type={f.type === "password" ? "password" : f.type === "number" ? "number" : "text"}
                placeholder={f.placeholder ?? ""}
                value={String(values[f.key] ?? "")}
                onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
              />
            )}
            {f.hint && <span className="muted" style={{ fontSize: 12 }}>{f.hint}</span>}
          </label>
        ))}
      </div>
      <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
        <button className="btn-primary small" disabled={saving} onClick={save}>{saving ? "保存中…" : "保存配置"}</button>
        <button className="btn-ghost small" onClick={() => onDone("")}>关闭</button>
      </div>
    </div>
  );
}

/** 插件管理（M5-γ 启停 + M6-α 应用市场：安装/升级/回滚/卸载，重启生效；v1.2.0 + 配置表单）。 */
export default function Plugins() {
  const [view, setView] = useState<PluginsView | null>(null);
  const [market, setMarket] = useState<MarketView | null>(null);
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<string | null>(null);

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
          {[...(view?.builtin ?? []), ...(view?.external ?? []).map((p) => ({ ...p, market: true as const }))].map((p) => {
            const on = view?.activated.includes(p.name) ?? false;
            const goods = (view?.goods_types ?? []).filter((g) => g.plugin === p.name).map((g) => g.label);
            const pays = (view?.pay_plugins ?? []).filter((g) => g.plugin === p.name).map((g) => g.label);
            const contrib = [...goods, ...pays].join(" / ") || "—";
            return (
              <tr key={p.name}>
                <td className="mono">{p.name}{(p as PluginRow & { market?: boolean }).market && <span style={{ color: "#a06b00", marginLeft: 4 }} title="市场安装的外部插件">🛒</span>}</td>
                <td>{p.version}</td>
                <td>{p.description}</td>
                <td>{contrib}</td>
                <td>{on ? "✅ 已启用" : "⛔ 已停用"}</td>
                <td>
                  <button className="btn-ghost small" onClick={() => toggle(p.name, on)}>
                    {on ? "停用" : "启用"}
                  </button>
                  {p.has_config && (
                    <button className="btn-ghost small" style={{ marginLeft: 6 }} onClick={() => setEditing(editing === p.name ? null : p.name)}>
                      配置
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {editing && <ConfigEditor name={editing} onDone={(m) => { if (m) setMsg(m); setEditing(null); }} />}

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
                    <td className="mono">{e.name}{e.paid && <span style={{ color: "#a06b00", marginLeft: 4 }} title="付费插件：安装/升级需 license">💰</span>}</td>
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
                          {e.paid && (
                            <button className="btn-ghost small" onClick={() => {
                              const content = prompt("粘贴市场下发的 .lic 文件内容（{payload,sig} JSON）：");
                              if (content && content.trim().length > 10) marketAction(() => importMarketLicense(e.name, content.trim()));
                            }}>导入 license</button>
                          )}
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
