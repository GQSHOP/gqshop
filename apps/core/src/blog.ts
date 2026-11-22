/**
 * M3 博客系统（ADR-006 B1/B2）：
 *   GET  /v1/blog/posts              — 文章列表（分页/分类/置顶排序）
 *   GET  /v1/blog/posts/[aliasOrGid] — 文章详情（views+1，含密码校验）
 *   GET  /v1/blog/navis              — 分类/导航
 *   GET  /v1/blog/posts/[gid]/comments — 文章评论（hide=n 已过审）
 *   POST /v1/blog/comments           — 发评论（登录即显 / 游客进审核）
 *   GET  /blog/rss.xml               — RSS（最新 20 篇）
 * admin：文章 CRUD / 分类 / 评论审核删除
 */
import { eq } from "drizzle-orm";
import { Hono } from "hono";

import { blogTable, commentTable } from "@gqshop/db";
import type { AppEnv } from "./index.js";
import { adminPermGuard } from "./lib/admin-auth.js";
import { requireAuthOptional } from "./lib/jwt.js";
import { ipRateLimit } from "./lib/rate-limit.js";
import { getOption } from "./lib/options.js";

export const blogRoutes = new Hono<AppEnv>();

// ============ 公开读 ============

blogRoutes.get("/v1/blog/posts", async (c) => {
  const pool = c.get("pool");
  const page = Math.max(1, Number(c.req.query("page") ?? 1));
  const limit = Math.min(50, Math.max(1, Number(c.req.query("limit") ?? 10)));
  const sortId = Number(c.req.query("sortid") ?? 0);
  const offset = (page - 1) * limit;
  const r = await pool.query(
    `SELECT b.gid, b.title, b.alias, b.cover, b.excerpt, b.date, b.sortid, b.top, b.views, b.comnum,
            n.naviname AS sort_name
     FROM dc_blog b LEFT JOIN dc_blog_navi n ON n.id = b.sortid
     WHERE b.type = 'blog' AND b.hide = 'n' AND b.checked = 'y'
       AND ($1::int = 0 OR b.sortid = $1::int)
     ORDER BY b.top DESC, b.sortop DESC, b.date DESC, b.gid DESC
     LIMIT $2 OFFSET $3`,
    [sortId, limit, offset],
  );
  return c.json({ code: 0, data: { list: r.rows, page, limit } });
});

blogRoutes.get("/v1/blog/posts/:key", async (c) => {
  const pool = c.get("pool");
  const key = (c.req.param("key") ?? "").slice(0, 255);
  // 数字 key 按 gid，否则按 alias——两条独立查询，避免列名条件拼接
  const isGid = /^\d+$/.test(key);
  const r = isGid
    ? await pool.query(
        `SELECT b.gid, b.title, b.alias, b.cover, b.content, b.excerpt, b.date, b.sortid, b.type,
                b.top, b.views, b.comnum, b.allow_remark, b.password, b.tags,
                n.naviname AS sort_name
         FROM dc_blog b LEFT JOIN dc_blog_navi n ON n.id = b.sortid
         WHERE b.gid = $1::int AND b.hide = 'n' AND b.checked = 'y' LIMIT 1`,
        [key],
      )
    : await pool.query(
        `SELECT b.gid, b.title, b.alias, b.cover, b.content, b.excerpt, b.date, b.sortid, b.type,
                b.top, b.views, b.comnum, b.allow_remark, b.password, b.tags,
                n.naviname AS sort_name
         FROM dc_blog b LEFT JOIN dc_blog_navi n ON n.id = b.sortid
         WHERE b.alias = $1 AND b.hide = 'n' AND b.checked = 'y' LIMIT 1`,
        [key],
      );
  const post = r.rows[0] as
    | { gid: number; title: string; alias: string; cover: string; content: string; excerpt: string;
        date: string; sortid: number; type: string; top: string; views: number; comnum: number;
        allow_remark: string; password: string; tags: string | null; sort_name: string | null }
    | undefined;
  if (!post) return c.json({ code: 404, msg: "post not found" }, 404);

  const pw = post.password ?? "";
  if (pw) {
    const supplied = c.req.query("pw") ?? "";
    if (supplied !== pw) {
      return c.json({ code: 403, msg: "password required", data: { gid: post.gid, title: post.title, locked: true } }, 403);
    }
  }
  // 浏览量原子 +1（冗余列，列表页免 count）
  await pool.query(`UPDATE dc_blog SET views = views + 1 WHERE gid = $1`, [post.gid]);
  return c.json({ code: 0, data: { ...post, views: post.views + 1, password: undefined } });
});

blogRoutes.get("/v1/blog/navis", async (c) => {
  const pool = c.get("pool");
  const r = await pool.query(
    `SELECT id, naviname, url, newtab, hide, taxis, pid, type, type_id, isdefault
     FROM dc_blog_navi WHERE hide = 'n' ORDER BY taxis ASC, id ASC`,
  );
  return c.json({ code: 0, data: r.rows });
});

blogRoutes.get("/v1/blog/posts/:gid/comments", async (c) => {
  const pool = c.get("pool");
  const gid = Number(c.req.param("gid"));
  if (!Number.isInteger(gid) || gid <= 0) return c.json({ code: 400, msg: "bad gid" }, 400);
  // 审查修复 L5：JOIN 用户昵称，登录评论显示 username 而非"用户{uid}"
  const r = await pool.query(
    `SELECT cm.cid, cm.pid, cm.poster, cm.uid, cm.comment, cm.date, u.username
     FROM dc_comment cm LEFT JOIN dc_user u ON u.uid = cm.uid
     WHERE cm.gid = $1 AND cm.hide = 'n' ORDER BY cm.cid ASC LIMIT 200`,
    [gid],
  );
  return c.json({ code: 0, data: r.rows });
});

// ============ 发评论 ============

blogRoutes.post("/v1/blog/comments", ipRateLimit(60_000, 10), requireAuthOptional(), async (c) => {
  const pool = c.get("pool");
  const uid = c.get("uid");
  const body = (await c.req.json().catch(() => null)) as
    | { gid?: number; pid?: number; poster?: string; comment?: string; mail?: string }
    | null;
  const gid = Number(body?.gid);
  const comment = (body?.comment ?? "").trim().slice(0, 2000);
  if (!Number.isInteger(gid) || gid <= 0 || !comment) {
    return c.json({ code: 400, msg: "gid and comment required" }, 400);
  }
  const g = await pool.query<{ allow_remark: string; hide: string }>(
    `SELECT allow_remark, hide FROM dc_blog WHERE gid = $1 LIMIT 1`,
    [gid],
  );
  const post = g.rows[0];
  if (!post || post.hide === "y") return c.json({ code: 404, msg: "post not found" }, 404);
  if (post.allow_remark !== "y") return c.json({ code: 403, msg: "comments closed" }, 403);

  // 登录用户直显；游客默认进审核（option blog_comment_audit，默认开）
  const auditOpt = await getOption(c.get("db"), "blog_comment_audit", "1");
  const guestAudit = auditOpt === "1";
  const isGuest = !uid;
  const hide = isGuest && guestAudit ? "y" : "n";
  const poster = uid
    ? ""
    : (body?.poster ?? "游客").trim().slice(0, 20) || "游客";
  const r = await pool.query<{ cid: number }>(
    `INSERT INTO dc_comment (gid, pid, top, poster, uid, comment, mail, url, ip, agent, hide, date)
     VALUES ($1, $2, 'n', $3, $4, $5, $6, '', $7, $8, $9, $10) RETURNING cid`,
    [gid, Math.max(0, Number(body?.pid ?? 0)), poster, uid ?? 0, comment,
      (body?.mail ?? "").slice(0, 60), c.req.header("x-forwarded-for") ?? "",
      (c.req.header("user-agent") ?? "").slice(0, 512), hide, Date.now()],
  );
  if (hide === "n") {
    await pool.query(`UPDATE dc_blog SET comnum = comnum + 1 WHERE gid = $1`, [gid]);
  }
  return c.json({
    code: 0, msg: hide === "y" ? "submitted for review" : "ok",
    data: { cid: r.rows[0]?.cid, pending: hide === "y" },
  }, 201);
});

// ============ RSS（ADR-006 B2：core 直出 XML） ============

blogRoutes.get("/blog/rss.xml", async (c) => {
  const pool = c.get("pool");
  const r = await pool.query<{ title: string; alias: string; excerpt: string; date: string; gid: number }>(
    `SELECT gid, title, alias, excerpt, date FROM dc_blog
     WHERE type = 'blog' AND hide = 'n' AND checked = 'y'
     ORDER BY date DESC LIMIT 20`,
  );
  const siteTitle = "GQSHOP Blog";
  const base = (process.env.GQSHOP_PUBLIC_BASE ?? "http://localhost:8100").replace(/\/$/, "");
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const items = r.rows
    .map((p) => {
      const link = `${base}/blog/${p.alias || p.gid}`;
      return `    <item>
      <title>${esc(p.title)}</title>
      <link>${link}</link>
      <guid>${link}</guid>
      <pubDate>${new Date(Number(p.date)).toUTCString()}</pubDate>
      <description>${esc((p.excerpt ?? "").slice(0, 500))}</description>
    </item>`;
    })
    .join("\n");
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>${esc(siteTitle)}</title>
    <link>${base}/blog</link>
    <description>${esc(siteTitle)}</description>
${items}
  </channel>
</rss>`;
  c.header("content-type", "application/rss+xml; charset=utf-8");
  return c.body(xml);
});

// ============ admin：文章 / 分类 / 评论（内联 admin key；UPDATE 走 drizzle setter） ============

blogRoutes.post("/v1/admin/blog/posts", async (c) => {
  const denied = await adminPermGuard(c, "blog.manage");
  if (denied) return denied;
  const pool = c.get("pool");
  const body = (await c.req.json().catch(() => null)) as
    | { title?: string; content?: string; excerpt?: string; alias?: string; sortid?: number; cover?: string; tags?: string; hide?: string }
    | null;
  const title = (body?.title ?? "").trim().slice(0, 255);
  const content = body?.content ?? "";
  if (!title || !content) return c.json({ code: 400, msg: "title/content required" }, 400);
  const now = Date.now();
  const r = await pool.query<{ gid: number }>(
    `INSERT INTO dc_blog (title, date, content, excerpt, cover, alias, author, sortid, type,
                          views, comnum, attnum, top, sortop, hide, checked, allow_remark, password, template, link, feedback)
     VALUES ($1, $2, $3, $4, $5, $6, 1, $7, 'blog', 0, 0, 0, 'n', 'n', $8, 'y', 'y', '', '', '', '')
     RETURNING gid`,
    [title, now, content, (body?.excerpt ?? content.slice(0, 200)).slice(0, 2000),
      (body?.cover ?? "").slice(0, 255), (body?.alias ?? "").slice(0, 255),
      Number(body?.sortid ?? -1), body?.hide === "y" ? "y" : "n"],
  );
  return c.json({ code: 0, data: { gid: r.rows[0]?.gid } }, 201);
});

blogRoutes.get("/v1/admin/blog/posts", async (c) => {
  const denied = await adminPermGuard(c, "blog.manage");
  if (denied) return denied;
  const pool = c.get("pool");
  const r = await pool.query(
    `SELECT b.gid, b.title, b.alias, b.date, b.sortid, b.views, b.comnum, b.hide, b.top,
            n.naviname AS sort_name
     FROM dc_blog b LEFT JOIN dc_blog_navi n ON n.id = b.sortid
     WHERE b.type = 'blog' ORDER BY b.gid DESC LIMIT 100`,
  );
  return c.json({ code: 0, data: r.rows });
});

/** 文章更新：drizzle 白名单 setter（无 SQL 拼接）。 */
blogRoutes.patch("/v1/admin/blog/posts/:gid", async (c) => {
  const denied = await adminPermGuard(c, "blog.manage");
  if (denied) return denied;
  const db = c.get("db");
  const gid = Number(c.req.param("gid"));
  const body = (await c.req.json().catch(() => null)) as
    | { title?: string; content?: string; excerpt?: string; alias?: string; sortid?: number; hide?: string; top?: string }
    | null;
  const sets: Partial<typeof blogTable.$inferInsert> = {};
  if (typeof body?.title === "string") sets.title = body.title.slice(0, 255);
  if (typeof body?.content === "string") sets.content = body.content;
  if (typeof body?.excerpt === "string") sets.excerpt = body.excerpt.slice(0, 2000);
  if (typeof body?.alias === "string") sets.alias = body.alias.slice(0, 255);
  if (body?.sortid !== undefined) sets.sortid = Number(body.sortid);
  if (typeof body?.hide === "string") sets.hide = body.hide === "y" ? "y" : "n";
  if (typeof body?.top === "string") sets.top = body.top === "y" ? "y" : "n";
  if (Object.keys(sets).length === 0) return c.json({ code: 400, msg: "nothing to update" }, 400);
  await db.update(blogTable).set(sets).where(eq(blogTable.gid, gid));
  return c.json({ code: 0, msg: "ok" });
});

blogRoutes.delete("/v1/admin/blog/posts/:gid", async (c) => {
  const denied = await adminPermGuard(c, "blog.manage");
  if (denied) return denied;
  const pool = c.get("pool");
  await pool.query(`DELETE FROM dc_blog WHERE gid = $1`, [Number(c.req.param("gid"))]);
  await pool.query(`DELETE FROM dc_comment WHERE gid = $1`, [Number(c.req.param("gid"))]);
  return c.json({ code: 0, msg: "deleted" });
});

blogRoutes.post("/v1/admin/blog/navis", async (c) => {
  const denied = await adminPermGuard(c, "blog.manage");
  if (denied) return denied;
  const pool = c.get("pool");
  const body = (await c.req.json().catch(() => null)) as
    | { naviname?: string; url?: string; type?: number; taxis?: number }
    | null;
  const name = (body?.naviname ?? "").trim().slice(0, 255);
  if (!name) return c.json({ code: 400, msg: "naviname required" }, 400);
  const r = await pool.query<{ id: number }>(
    `INSERT INTO dc_blog_navi (naviname, url, newtab, hide, taxis, pid, type, type_id, isdefault, naviicon)
     VALUES ($1, $2, 'n', 'n', $3, 0, $4, 0, 'n', '') RETURNING id`,
    [name, (body?.url ?? "").slice(0, 512), Number(body?.taxis ?? 0), Number(body?.type ?? 0)],
  );
  return c.json({ code: 0, data: { id: r.rows[0]?.id } }, 201);
});

blogRoutes.get("/v1/admin/blog/comments", async (c) => {
  const denied = await adminPermGuard(c, "blog.moderate");
  if (denied) return denied;
  const pool = c.get("pool");
  const r = await pool.query(
    `SELECT cm.cid, cm.gid, cm.pid, cm.poster, cm.uid, u.username, cm.comment, cm.hide, cm.date
     FROM dc_comment cm LEFT JOIN dc_user u ON u.uid = cm.uid
     ORDER BY cm.cid DESC LIMIT 100`,
  );
  return c.json({ code: 0, data: r.rows });
});

blogRoutes.patch("/v1/admin/blog/comments/:cid", async (c) => {
  const denied = await adminPermGuard(c, "blog.moderate");
  if (denied) return denied;
  const pool = c.get("pool");
  const cid = Number(c.req.param("cid"));
  const body = (await c.req.json().catch(() => null)) as { hide?: string } | null;
  const newHide = body?.hide === "y" ? "y" : "n";
  // 审查修复 L2：RETURNING 只给新值——旧值必须先查，否则 delta 恒 0、comnum 永不联动
  const prev = await pool.query<{ gid: number; hide: string }>(
    `SELECT gid, hide FROM dc_comment WHERE cid = $1`,
    [cid],
  );
  const old = prev.rows[0];
  if (!old) return c.json({ code: 404, msg: "not found" }, 404);
  if (old.hide !== newHide) {
    await pool.query(`UPDATE dc_comment SET hide = $2 WHERE cid = $1`, [cid, newHide]);
    // 冗余计数联动：y→n 过审 +1；n→y 隐藏 -1
    const delta = newHide === "n" ? 1 : -1;
    await pool.query(`UPDATE dc_blog SET comnum = GREATEST(0, comnum + $1) WHERE gid = $2`, [delta, old.gid]);
  }
  return c.json({ code: 0, msg: "ok" });
});

blogRoutes.delete("/v1/admin/blog/comments/:cid", async (c) => {
  const denied = await adminPermGuard(c, "blog.moderate");
  if (denied) return denied;
  const pool = c.get("pool");
  const r = await pool.query<{ gid: number; hide: string }>(
    `DELETE FROM dc_comment WHERE cid = $1 RETURNING gid, hide`,
    [Number(c.req.param("cid"))],
  );
  const del = r.rows[0];
  if (del && del.hide === "n") {
    // 审查修复 L2：未过审（hide='y'）评论未计入 comnum，删除时不应扣减
    await pool.query(`UPDATE dc_blog SET comnum = GREATEST(0, comnum - 1) WHERE gid = $1`, [del.gid]);
  }
  return c.json({ code: 0, msg: "deleted" });
});
