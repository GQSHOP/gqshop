import { useCallback, useEffect, useState } from "react";

import {
  getAftersaleChat,
  getAftersales,
  replyAftersale,
  type AftersaleChatMsg,
  type AftersaleRow,
} from "../api.js";

const TYPE_LABEL: Record<string, string> = { refund: "退款", resend: "补发", other: "其他" };
const STATUS_LABEL: Record<number, string> = { 0: "待处理", 1: "处理中", 2: "已完成" };

export default function Aftersale() {
  const [list, setList] = useState<AftersaleRow[]>([]);
  const [active, setActive] = useState<number>(0);
  const [chat, setChat] = useState<AftersaleChatMsg[]>([]);
  const [reply, setReply] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(() => {
    getAftersales()
      .then(setList)
      .catch((e) => setError(String(e.message)));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const openChat = useCallback((id: number) => {
    setActive(id);
    getAftersaleChat(id)
      .then(setChat)
      .catch((e) => setError(String(e.message)));
  }, []);

  async function send(resolve?: boolean) {
    if (!reply.trim()) return;
    try {
      await replyAftersale(active, reply.trim(), resolve);
      setReply("");
      openChat(active);
      load();
    } catch (e) {
      setError(String((e as Error).message));
    }
  }

  const current = list.find((a) => a.id === active);

  return (
    <div>
      <h2 className="page-title">售后工单</h2>
      {error && <p className="error">{error}</p>}
      <div style={{ display: "grid", gridTemplateColumns: "3fr 2fr", gap: 16 }}>
        <table className="table">
          <thead>
            <tr>
              <th>ID</th>
              <th>订单号</th>
              <th>商品</th>
              <th>类型</th>
              <th>状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {list.length === 0 && (
              <tr>
                <td colSpan={6} className="empty">
                  暂无售后单
                </td>
              </tr>
            )}
            {list.map((a) => (
              <tr key={a.id} className={a.id === active ? "row-active" : ""}>
                <td>{a.id}</td>
                <td className="mono">{a.out_trade_no}</td>
                <td>{a.goods_title}</td>
                <td>{TYPE_LABEL[a.type] ?? a.type}</td>
                <td>{STATUS_LABEL[a.status] ?? a.status}</td>
                <td>
                  <button className="btn-ghost small" onClick={() => openChat(a.id)}>
                    处理
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {active > 0 && current && (
          <div className="panel">
            <h3>#{current.id} · {current.out_trade_no}</h3>
            <p>
              {TYPE_LABEL[current.type] ?? current.type} · {STATUS_LABEL[current.status]} · 联系方式：{current.contact || "—"}
            </p>
            <div className="chat-box">
              {chat.map((m, i) => (
                <div key={i} className={m.sender_type === "admin" ? "chat-admin" : "chat-user"}>
                  <strong>{m.sender_type === "admin" ? "管理员" : "用户"}</strong>
                  <p>{m.content}</p>
                </div>
              ))}
            </div>
            <textarea
              rows={3}
              placeholder="回复内容（说明退款/补发处理结果）"
              value={reply}
              onChange={(e) => setReply(e.target.value)}
            />
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <button className="btn-ghost" onClick={() => send(false)} disabled={!reply.trim()}>
                回复
              </button>
              <button className="btn-primary" onClick={() => send(true)} disabled={!reply.trim()}>
                回复并结单
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
