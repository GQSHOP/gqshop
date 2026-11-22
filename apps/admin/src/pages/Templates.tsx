import { useCallback, useEffect, useState } from "react";

import { getTemplates, setDefaultTemplate } from "../api.js";

interface TplView {
  templates: string[];
  current: string;
  templates_root: string;
  available: boolean;
}

/** 模板管理（M5-β，权限位 template.manage）：注册表列表 + 设全局默认（front_default）。 */
export default function Templates() {
  const [view, setView] = useState<TplView | null>(null);
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(() => {
    getTemplates().then(setView).catch((e) => setError(String(e.message)));
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  async function activate(name: string) {
    setError("");
    setMsg("");
    try {
      await setDefaultTemplate(name);
      setMsg(`已切换默认模板：${name}（分店未单独指定时全局生效）`);
      load();
    } catch (e) {
      setError(String((e as Error).message));
    }
  }

  return (
    <div>
      <h2 className="page-title">模板管理</h2>
      <p className="hint">
        选择链：分店指定模板 &gt; 全局默认（front_default）&gt; default 兜底。模板目录：
        {view?.templates_root || "未配置"}
      </p>
      {error && <p className="error">{error}</p>}
      {msg && <p className="hint">{msg}</p>}
      {!view?.available && <p className="hint">未发现已注册模板（检查 GQSHOP_TEMPLATES_ROOT 与构建产物）</p>}
      <table className="table">
        <thead>
          <tr>
            <th>模板名</th>
            <th>状态</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {(view?.templates ?? []).map((t) => (
            <tr key={t}>
              <td>{t}</td>
              <td>{view?.current === t ? "✅ 当前默认" : "-"}</td>
              <td>
                <button className="btn-ghost small" disabled={view?.current === t} onClick={() => activate(t)}>
                  设为默认
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
