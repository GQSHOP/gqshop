import { useCallback, useEffect, useState } from "react";

import { assignMember, createGroup, deleteGroup, getGroups, updateGroup } from "../api.js";

interface GroupRow {
  id: number;
  name: string;
  menu_permissions: string;
  member_count: number;
}

function parsePerms(raw: string): string[] {
  try {
    const p = JSON.parse(raw) as { perms?: string[] };
    return Array.isArray(p.perms) ? p.perms : [];
  } catch {
    return [];
  }
}

/** 用户组管理（M5-α，权限位 group.manage）：组 CRUD + 成员分配。 */
export default function Groups() {
  const [list, setList] = useState<GroupRow[]>([]);
  const [allPerms, setAllPerms] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [name, setName] = useState("");
  const [perms, setPerms] = useState<string[]>([]);
  const [memberName, setMemberName] = useState("");
  const [memberGroup, setMemberGroup] = useState(0);

  const load = useCallback(() => {
    getGroups()
      .then((d) => {
        setList(d.list);
        setAllPerms(d.all_perms);
      })
      .catch((e) => setError(String(e.message)));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function flipPerm(p: string) {
    setPerms((prev) => (prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p]));
  }

  async function create() {
    setError("");
    setMsg("");
    if (!name.trim()) return setError("组名必填");
    try {
      await createGroup(name.trim(), perms);
      setMsg("已创建");
      setName("");
      setPerms([]);
      load();
    } catch (e) {
      setError(String((e as Error).message));
    }
  }

  async function saveGroup(g: GroupRow, next: string[]) {
    try {
      await updateGroup(g.id, { perms: next });
      setMsg(`「${g.name}」权限已保存`);
      load();
    } catch (e) {
      setError(String((e as Error).message));
    }
  }

  async function assign(op: "add" | "remove") {
    setError("");
    setMsg("");
    if (!memberName.trim()) return setError("管理员账号名必填");
    try {
      await assignMember(memberGroup, memberName.trim(), op);
      setMsg(op === "add" ? "已入组（重新登录后生效）" : "已移出（重新登录后生效）");
      setMemberName("");
      load();
    } catch (e) {
      setError(String((e as Error).message));
    }
  }

  return (
    <div>
      <h2 className="page-title">用户组管理</h2>
      <p className="hint">权限按「域.动作」粒度下发；未分组（组 0）与创始人账号拥有全部权限。</p>
      {error && <p className="error">{error}</p>}
      {msg && <p className="hint">{msg}</p>}

      <div className="panel" style={{ marginBottom: 16 }}>
        <h3>新建用户组</h3>
        <div className="form-grid">
          <label>
            组名
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="如：客服组" />
          </label>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, margin: "10px 0" }}>
          {allPerms.map((p) => (
            <label key={p} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 13 }}>
              <input type="checkbox" checked={perms.includes(p)} onChange={() => flipPerm(p)} />
              {p}
            </label>
          ))}
        </div>
        <button className="btn-primary" onClick={create}>
          创建
        </button>
      </div>

      <table className="table">
        <thead>
          <tr>
            <th>ID</th>
            <th>组名</th>
            <th>权限位</th>
            <th>成员数</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {list.length === 0 && (
            <tr>
              <td colSpan={5} className="empty">
                暂无用户组
              </td>
            </tr>
          )}
          {list.map((g) => {
            const cur = parsePerms(g.menu_permissions);
            const all = cur.includes("*");
            return (
              <tr key={g.id}>
                <td>{g.id}</td>
                <td>{g.name}</td>
                <td>
                  {all ? (
                    <span className="hint">全部权限（*）</span>
                  ) : (
                    <span style={{ fontSize: 12 }}>{cur.join(" / ") || "（无）"}</span>
                  )}
                </td>
                <td>{g.member_count}</td>
                <td>
                  {!all && (
                    <>
                      <button
                        className="btn-ghost small"
                        onClick={() => saveGroup(g, [...cur, ...allPerms.filter((p) => !cur.includes(p))])}
                      >
                        全选
                      </button>{" "}
                      <button className="btn-ghost small" onClick={() => saveGroup(g, [])}>
                        清空
                      </button>{" "}
                    </>
                  )}
                  <button
                    className="btn-ghost small"
                    onClick={async () => {
                      if (!confirm(`删除用户组「${g.name}」？`)) return;
                      try {
                        await deleteGroup(g.id);
                        load();
                      } catch (e) {
                        setError(String((e as Error).message));
                      }
                    }}
                  >
                    删除
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <div className="panel" style={{ marginTop: 16 }}>
        <h3>成员分配</h3>
        <p className="hint">将 role=admin 的账号加入受限组；移出后回到超管（组 0）。变更需对方重新登录生效。</p>
        <div className="form-grid">
          <label>
            管理员账号
            <input value={memberName} onChange={(e) => setMemberName(e.target.value)} placeholder="username" />
          </label>
          <label>
            用户组
            <select value={memberGroup} onChange={(e) => setMemberGroup(Number(e.target.value))}>
              <option value={0}>选择组…</option>
              {list.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <button className="btn-primary" disabled={!memberGroup} onClick={() => assign("add")}>
          加入组
        </button>{" "}
        <button className="btn-ghost" disabled={!memberGroup} onClick={() => assign("remove")}>
          移出组
        </button>
      </div>
    </div>
  );
}
