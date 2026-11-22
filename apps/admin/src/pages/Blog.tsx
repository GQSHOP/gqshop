import { useCallback, useEffect, useState } from "react";

import {
  createBlogPost,
  deleteBlogComment,
  deleteBlogPost,
  getBlogComments,
  getBlogPosts,
  setBlogCommentHide,
  updateBlogPost,
  type BlogCommentRow,
  type BlogPostRow,
} from "../api.js";

/** 博客管理（ADR-006 B3）：文章 + 评论审核。 */
export default function Blog() {
  const [posts, setPosts] = useState<BlogPostRow[]>([]);
  const [comments, setComments] = useState<BlogCommentRow[]>([]);
  const [tab, setTab] = useState<"posts" | "comments">("posts");
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ title: "", alias: "", excerpt: "", content: "" });

  const load = useCallback(() => {
    getBlogPosts().then(setPosts).catch((e) => setError(String(e.message)));
    getBlogComments().then(setComments).catch(() => {});
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function submit() {
    try {
      await createBlogPost({
        title: form.title,
        content: form.content,
        excerpt: form.excerpt || form.content.slice(0, 200),
        alias: form.alias || undefined,
      });
      setCreating(false);
      setForm({ title: "", alias: "", excerpt: "", content: "" });
      load();
    } catch (e) {
      setError(String((e as Error).message));
    }
  }

  async function flipHide(p: BlogPostRow) {
    await updateBlogPost(p.gid, { hide: p.hide === "y" ? "n" : "y" });
    load();
  }

  async function removePost(gid: number) {
    if (!window.confirm("删除文章及其评论？")) return;
    await deleteBlogPost(gid);
    load();
  }

  return (
    <div>
      <h2 className="page-title">博客管理</h2>
      <div className="toolbar">
        <button className={tab === "posts" ? "btn-primary" : "btn-ghost"} onClick={() => setTab("posts")}>文章</button>
        <button className={tab === "comments" ? "btn-primary" : "btn-ghost"} onClick={() => setTab("comments")}>
          评论{comments.some((cm) => cm.hide === "y") ? "🔴" : ""}
        </button>
        {tab === "posts" && (
          <button className="btn-primary" onClick={() => setCreating(!creating)}>
            {creating ? "取消" : "＋ 新文章"}
          </button>
        )}
      </div>
      {error && <p className="error">{error}</p>}

      {tab === "posts" && creating && (
        <div className="panel">
          <div className="form-grid">
            <label>标题<input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></label>
            <label>别名（选填，URL 用）<input value={form.alias} onChange={(e) => setForm({ ...form, alias: e.target.value })} /></label>
          </div>
          <label className="block">
            摘要（选填）
            <textarea rows={2} value={form.excerpt} onChange={(e) => setForm({ ...form, excerpt: e.target.value })} />
          </label>
          <label className="block">
            正文（Markdown/HTML）
            <textarea rows={10} value={form.content} onChange={(e) => setForm({ ...form, content: e.target.value })} />
          </label>
          <button className="btn-primary" disabled={!form.title || !form.content} onClick={submit}>发布</button>
        </div>
      )}

      {tab === "posts" && (
        <table className="table">
          <thead><tr><th>gid</th><th>标题</th><th>阅读/评论</th><th>状态</th><th>操作</th></tr></thead>
          <tbody>
            {posts.length === 0 && <tr><td colSpan={5} className="empty">暂无文章</td></tr>}
            {posts.map((p) => (
              <tr key={p.gid}>
                <td>{p.gid}</td>
                <td>{p.title}{p.alias ? <span className="muted">（{p.alias}）</span> : ""}</td>
                <td>{p.views} / {p.comnum}</td>
                <td>{p.hide === "y" ? "草稿" : "已发布"}</td>
                <td>
                  <button className="btn-ghost small" onClick={() => flipHide(p)}>
                    {p.hide === "y" ? "发布" : "转草稿"}
                  </button>
                  <button className="btn-ghost small" onClick={() => removePost(p.gid)}>删除</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {tab === "comments" && (
        <table className="table">
          <thead><tr><th>cid</th><th>文章</th><th>昵称</th><th>内容</th><th>状态</th><th>操作</th></tr></thead>
          <tbody>
            {comments.length === 0 && <tr><td colSpan={6} className="empty">暂无评论</td></tr>}
            {comments.map((cm) => (
              <tr key={cm.cid}>
                <td>{cm.cid}</td>
                <td>#{cm.gid}</td>
                <td>{cm.poster || cm.username || `用户${cm.uid}`}</td>
                <td style={{ maxWidth: 400 }}>{cm.comment.slice(0, 100)}</td>
                <td>{cm.hide === "y" ? "🔴 待审核" : "已过审"}</td>
                <td>
                  <button className="btn-ghost small" onClick={async () => { await setBlogCommentHide(cm.cid, cm.hide === "y" ? "n" : "y"); load(); }}>
                    {cm.hide === "y" ? "通过" : "隐藏"}
                  </button>
                  <button className="btn-ghost small" onClick={async () => { if (window.confirm("删除评论？")) { await deleteBlogComment(cm.cid); load(); } }}>删除</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
