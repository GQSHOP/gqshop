import { useCallback, useEffect, useState } from "react";

import { getPlugins, togglePlugin } from "../api.js";

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

/** 插件管理（M5-γ，权限位 plugin.manage）：启停 active_plugins（重启生效）。 */
export default function Plugins() {
  const [view, setView] = useState<PluginsView | null>(null);
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(() => {
    getPlugins().then(setView).catch((e) => setError(String(e.message)));
  }, []);
  useEffect(() => {
    load();
  }, [load]);

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
    </div>
  );
}
