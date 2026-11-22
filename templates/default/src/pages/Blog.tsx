/** 店面博客页（列表/详情/评论），对接 /v1/blog/*（ADR-006）。 */
import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";

const BASE = "/v1";

async function blogApi<T>(path: string, init?: RequestInit): Promise<T> {
  const token = localStorage.getItem("gqshop-token");
  const res = await fetch(BASE + path, {
    headers: { "content-type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...init,
  });
  const body = (await res.json()) as { code: number; msg: string; data?: T };
  if (body.code !== 0) throw new Error(body.msg || `API ${body.code}`);
  return body.data as T;
}

export interface BlogPost {
  gid: number;
  title: string;
  alias: string | null;
  excerpt: string | null;
  views: number;
  comnum: number;
  date: string | null;
}
export interface BlogDetail extends BlogPost {
  content: string;
}
export interface BlogComment {
  cid: number;
  poster: string;
  uid: number;
  username: string | null;
  comment: string;
  date: string;
}

export function BlogList() {
  const [posts, setPosts] = useState<BlogPost[]>([]);
  useEffect(() => {
    blogApi<{ list: BlogPost[] }>("/blog/posts?page=1").then((d) => setPosts(d.list)).catch(() => {});
  }, []);
  return (
    <main className="container page">
      <div className="blog-list">
        <h2 className="page-title">博客</h2>
        {posts.length === 0 && <p className="empty">暂无文章</p>}
        {posts.map((p) => (
          <Link className="blog-item" key={p.gid} to={`/blog/${p.alias || p.gid}`}>
            <h3>{p.title}</h3>
            <p className="muted">{p.excerpt ?? ""}</p>
            <p className="hint">
              {p.date ? new Date(Number(p.date) * 1000).toLocaleDateString() : ""} · 阅读 {p.views} · 评论 {p.comnum}
            </p>
          </Link>
        ))}
      </div>
    </main>
  );
}

export function BlogDetail() {
  const { key } = useParams();
  const [post, setPost] = useState<BlogDetail | null>(null);
  const [comments, setComments] = useState<BlogComment[]>([]);
  const [poster, setPoster] = useState("");
  const [comment, setComment] = useState("");
  const [msg, setMsg] = useState("");

  const load = useCallback(() => {
    if (!key) return;
    blogApi<BlogDetail>(`/blog/posts/${key}`).then(setPost).catch((e) => setMsg(String(e.message)));
    blogApi<{ list: BlogComment[] }>(`/blog/posts/${key}/comments`)
      .then((d) => setComments(d.list))
      .catch(() => {});
  }, [key]);

  useEffect(() => {
    load();
  }, [load]);

  async function submitComment() {
    if (!post || !comment.trim()) return;
    try {
      await blogApi("/blog/comments", {
        method: "POST",
        body: JSON.stringify({ gid: post.gid, poster: poster.trim() || "游客", comment: comment.trim() }),
      });
      setComment("");
      setMsg("评论已提交（若开启审核则待显示）");
      load();
    } catch (e) {
      setMsg(String((e as Error).message));
    }
  }

  if (msg && !post) return <main className="container page"><p className="empty">{msg}</p></main>;
  if (!post) return <main className="container page"><p className="empty">加载中…</p></main>;

  return (
    <main className="container page">
      <article className="blog-detail">
        <h2>{post.title}</h2>
        <p className="hint">
          {post.date ? new Date(Number(post.date) * 1000).toLocaleDateString() : ""} · 阅读 {post.views} · 评论 {post.comnum}
        </p>
        <div className="blog-content" dangerouslySetInnerHTML={{ __html: post.content ?? "" }} />

        <h3 className="section-title">评论（{comments.length}）</h3>
        <div className="panel">
          <div className="toolbar">
            <input placeholder="昵称（游客可填）" value={poster} onChange={(e) => setPoster(e.target.value)} />
          </div>
          <textarea rows={3} placeholder="说点什么…" value={comment} onChange={(e) => setComment(e.target.value)} />
          <button className="btn-primary" onClick={submitComment} disabled={!comment.trim()}>
            发表评论
          </button>
          {msg && <p className="hint">{msg}</p>}
        </div>
        {comments.map((c) => (
          <div className="blog-comment" key={c.cid}>
            <strong>{c.poster || c.username || `用户${c.uid}`}</strong>
            <p>{c.comment}</p>
            <p className="hint">{c.date ? new Date(Number(c.date) * 1000).toLocaleString() : ""}</p>
          </div>
        ))}
        <p className="hint"><Link to="/blog">← 返回列表</Link></p>
      </article>
    </main>
  );
}
