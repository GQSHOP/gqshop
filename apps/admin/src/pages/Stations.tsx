import { useCallback, useEffect, useState } from "react";

import { getStationStats, getStations, setStationStatus, type AdminStation, type StationStats } from "../api.js";

export default function Stations() {
  const [list, setList] = useState<AdminStation[]>([]);
  const [stats, setStats] = useState<StationStats[]>([]);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    getStations().then(setList).catch((e) => setError(String(e.message)));
    getStationStats().then(setStats).catch(() => {});
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function flip(s: AdminStation) {
    await setStationStatus(s.id, s.status === 1 ? 0 : 1);
    load();
  }

  const statsMap = new Map(stats.map((s) => [s.id, s]));

  return (
    <div>
      <h2 className="page-title">分店管理</h2>
      {error && <p className="error">{error}</p>}
      <table className="table">
        <thead>
          <tr>
            <th>ID</th>
            <th>店主</th>
            <th>店铺</th>
            <th>slug / 域名</th>
            <th>等级</th>
            <th>开通价</th>
            <th>销售额 / 订单</th>
            <th>状态</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {list.length === 0 && (
            <tr>
              <td colSpan={9} className="empty">
                暂无分店
              </td>
            </tr>
          )}
          {list.map((s) => {
            const st = statsMap.get(s.id);
            return (
              <tr key={s.id}>
                <td>{s.id}</td>
                <td>{s.username ?? `#${s.user_id}`}</td>
                <td>{s.name ?? "-"}</td>
                <td className="mono">
                  /s/{s.slug}
                  {s.domain ? <br /> : null}
                  {s.domain ?? ""}
                </td>
                <td>{s.level_name ?? "-"}</td>
                <td>¥{Number(s.amount).toFixed(2)}</td>
                <td>
                  ¥{((Number(st?.sales_total ?? 0)) / 100).toFixed(2)} / {st?.order_count ?? 0}
                </td>
                <td>{s.status === 1 ? "✅ 启用" : "⛔ 停用"}</td>
                <td>
                  <button className="btn-ghost small" onClick={() => flip(s)}>
                    {s.status === 1 ? "停用" : "启用"}
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
