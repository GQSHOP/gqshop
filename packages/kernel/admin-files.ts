/**
 * M4-δ 后台文件上传（封面图等）+ 商品编辑。
 * 上传：multipart 落盘到 GQSHOP_UPLOAD_DIR（白名单扩展名+大小上限+magic 校验），
 * 返回可访问 URL（/uploads/<name>）。商品编辑用静态 COALESCE 参数化 UPDATE（无拼接）。
 */
import { Hono } from "hono";
import bcrypt from "bcryptjs";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";

import type { AppEnv } from "./app-env.js";
import { adminPermGuard, signAdminToken } from "./admin-auth.js";
import { clientIp, ipRateLimit, loginFailClear, loginFailGuard, loginFailRecord } from "./rate-limit.js";

// 审查修复 L1：移除 .svg——SVG 可内嵌 <script>，直接导航访问 /uploads/*.svg 即执行
// （存储型 XSS 面）。封面图场景 jpg/png/webp/gif 足够
const ALLOWED_EXT = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);
const MAX_BYTES = 5 * 1024 * 1024;

function uploadDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.GQSHOP_UPLOAD_DIR ?? "./data/uploads";
}

export const adminUploadRoutes = new Hono<AppEnv>();
/** 登录端点：公开（凭据即门禁），必须在 /v1/admin/* 鉴权中间件之前挂载。 */
export const adminLoginRoutes = new Hono<AppEnv>();

/**
 * 后台账号登录（M5-α 升级：会话票制）：username+password 对 gq_user 验证（role=admin、bcrypt），
 * 通过后签发 admin JWT（8h，scope="admin"）——不再下发全局 GQSHOP_ADMIN_KEY（审计 M3 收口）。
 * v1.1.1：X-Admin-Key 机器通道已删除。失败锁定：uid+IP 双维度 5 次锁 15 分钟（审计 M2 收口）。
 */
adminLoginRoutes.post("/v1/admin/login", ipRateLimit(60_000, 10), async (c) => {
  const body = (await c.req.json().catch(() => null)) as
    | { username?: string; password?: string }
    | null;
  const username = String(body?.username ?? "").slice(0, 32);
  const password = String(body?.password ?? "");
  if (!username || !password) return c.json({ code: 400, msg: "username/password required" }, 400);
  const ip = clientIp(c);
  if (loginFailGuard(username, ip)) {
    return c.json({ code: 429, msg: "too many failed attempts, locked for 15 minutes" }, 429);
  }
  const pool = c.get("pool");
  const r = await pool.query(
    `SELECT uid, username, password, role, state, admin_group_id FROM gq_user WHERE username = $1 AND delete_time IS NULL LIMIT 1`,
    [username],
  );
  const u = r.rows[0] as { uid: number; username: string; password: string; role: string; state: number; admin_group_id: number } | undefined;
  if (!u || u.state !== 0 || u.role !== "admin" || !bcrypt.compareSync(password, u.password)) {
    loginFailRecord(username, ip);
    // 统一 401（不区分"不存在/非 admin/密码错"，避免账号枚举）
    return c.json({ code: 401, msg: "invalid credentials" }, 401);
  }
  loginFailClear(username, ip);
  const token = await signAdminToken(c.get("jwtSecret"), u.uid, u.admin_group_id ?? 0, u.username);
  return c.json({ code: 0, data: { token, uid: u.uid, username: u.username, group_id: u.admin_group_id ?? 0 } });
});

adminUploadRoutes.post("/v1/admin/upload", async (c) => {
  const denied = await adminPermGuard(c, "goods.manage");
  if (denied) return denied;
  const body = await c.req.parseBody().catch(() => null);
  const file = body?.file;
  if (!file || typeof file === "string") {
    return c.json({ code: 400, msg: "multipart file field required" }, 400);
  }
  if (file.size > MAX_BYTES) {
    return c.json({ code: 400, msg: "file too large (max 5MB)" }, 400);
  }
  const ext = extname(file.name).toLowerCase();
  if (!ALLOWED_EXT.has(ext)) {
    return c.json({ code: 400, msg: "only jpg/jpeg/png/webp/gif allowed" }, 400);
  }
  const buf = Buffer.from(await file.arrayBuffer());
  // 内容校验：扩展名与魔数一致
  const hex4 = buf.subarray(0, 4).toString("hex");
  const magicOk =
    hex4.startsWith("89504e") ||
    hex4.startsWith("ffd8ff") ||
    hex4.startsWith("47494638") ||
    (hex4 === "52494646" && buf.subarray(8, 12).toString() === "WEBP");
  if (!magicOk) {
    return c.json({ code: 400, msg: "file content does not match extension" }, 400);
  }
  const dir = uploadDir();
  mkdirSync(dir, { recursive: true });
  const name = `${Date.now()}_${randomBytes(4).toString("hex")}${ext}`;
  writeFileSync(join(dir, name), buf);
  return c.json({ code: 0, data: { url: `/uploads/${name}`, name } }, 201);
});

/** 读取上传文件（路径净化，防穿越；svg 历史残留也拒绝执行）。 */
export function readUploadSafe(name: string, env: NodeJS.ProcessEnv = process.env): Buffer | null {
  const safe = name.replace(/[^a-zA-Z0-9_.-]/g, "");
  if (!safe || safe.startsWith(".")) return null;
  if (safe.toLowerCase().endsWith(".svg")) return null; // L1：双向封禁（含历史文件）
  const root = resolve(uploadDir(env));
  const full = resolve(root, safe);
  if (!full.startsWith(root)) return null;
  if (!existsSync(full)) return null;
  return readFileSync(full);
}

/** 商品编辑：静态 COALESCE UPDATE——未提供的字段保持原值（全参数化，零拼接）。
 *  功能池②：password/pay_content（密码商品/付费内容）入编辑面；传空串=清空。 */
adminUploadRoutes.patch("/v1/admin/goods/:id", async (c) => {
  const denied = await adminPermGuard(c, "goods.manage");
  if (denied) return denied;
  const pool = c.get("pool");
  const id = Number(c.req.param("id"));
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return c.json({ code: 400, msg: "invalid json body" }, 400);

  const title = typeof body.title === "string" && body.title.trim() ? body.title.trim().slice(0, 150) : null;
  const cover = typeof body.cover === "string" ? body.cover.slice(0, 255) : null;
  const content = typeof body.content === "string" ? body.content.slice(0, 50000) : null;
  const unitName = typeof body.unit_name === "string" && body.unit_name.trim() ? body.unit_name.trim().slice(0, 30) : null;
  const password = typeof body.password === "string" ? body.password.slice(0, 64) : null;
  const payContent = typeof body.pay_content === "string" ? body.pay_content.slice(0, 20000) : null;
  if (title === null && cover === null && content === null && unitName === null && password === null && payContent === null) {
    return c.json({ code: 400, msg: "nothing to update (title/cover/content/unit_name/password/pay_content)" }, 400);
  }
  // gq_goods 无 update_time 列（1:1 平移），仅动业务字段
  const r = await pool.query(
    `UPDATE gq_goods SET
       title = COALESCE($1, title),
       cover = COALESCE($2, cover),
       content = COALESCE($3, content),
       unit_name = COALESCE($4, unit_name),
       password = COALESCE($5, password),
       pay_content = COALESCE($6, pay_content)
     WHERE id = $7 AND delete_time IS NULL`,
    [title, cover, content, unitName, password, payContent, id],
  );
  if (r.rowCount !== 1) return c.json({ code: 404, msg: "goods not found" }, 404);
  return c.json({ code: 0, msg: "updated" });
});
