/**
 * JWT helpers (HS256). hono/jwt 注意：sign/verify 均为异步，必须 await；
 * sign 第一参数只收 payload（此前误传 JWS 结构曾把密钥泄进 token）。
 */
import { sign, verify } from "hono/jwt";

export interface JwtPayload {
  uid: number;
  username: string;
  level: number;
  exp: number;
}

const JWT_EXPIRES_SEC = 60 * 60 * 24; // 24h

export async function signToken(secret: string, payload: Omit<JwtPayload, "exp">): Promise<string> {
  return await sign(
    { ...payload, exp: Math.floor(Date.now() / 1000) + JWT_EXPIRES_SEC },
    secret,
    "HS256",
  );
}

export async function verifyToken(secret: string, token: string): Promise<JwtPayload | null> {
  try {
    const p = (await verify(token, secret, "HS256")) as unknown as JwtPayload;
    if (!p.uid || p.exp * 1000 < Date.now()) return null;
    return p;
  } catch {
    return null;
  }
}

import type { Context, Next } from "hono";

/** JWT 鉴权中间件：验证通过写入 uid。
 *  M5-α（审计 M4 收口）：拒收 admin 会话票（scope="admin"），并实时核 role——
 *  admin 账号不进用户中心（双入口隔离，含修复前签发的旧 token 兼容窗口收口）。 */
export function requireAuth() {
  return async (
    c: Context<{ Variables: { jwtSecret: string; uid?: number; pool?: import("pg").Pool } }>,
    next: Next,
  ) => {
    const auth = c.req.header("Authorization");
    const raw = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
    if (!raw) return c.json({ code: 401, msg: "login required" }, 401);
    // admin 票带 scope 声明，直接拒（verifyToken 不校验 scope，此处显式判）
    try {
      const parts = JSON.parse(Buffer.from(raw.split(".")[1] ?? "", "base64url").toString("utf8")) as { scope?: string };
      if (parts.scope === "admin") return c.json({ code: 401, msg: "admin token not accepted here" }, 401);
    } catch {
      return c.json({ code: 401, msg: "invalid token" }, 401);
    }
    const payload = await verifyToken(c.get("jwtSecret"), raw);
    if (!payload) return c.json({ code: 401, msg: "login required" }, 401);
    const pool = c.get("pool");
    if (pool) {
      const u = await pool.query<{ role: string; state: number }>(
        `SELECT role, state FROM dc_user WHERE uid = $1 AND delete_time IS NULL LIMIT 1`,
        [payload.uid],
      );
      const row = u.rows[0];
      if (!row || row.state !== 0 || row.role === "admin") {
        return c.json({ code: 401, msg: "account not allowed on user APIs" }, 401);
      }
    }
    c.set("uid", payload.uid);
    await next();
  };
}

/** 可选鉴权：有有效 token 则写入 uid，游客静默通过（下单/查单共用）。 */
export function requireAuthOptional() {
  return async (c: Context<{ Variables: { jwtSecret: string; uid?: number } }>, next: Next) => {
    const auth = c.req.header("Authorization");
    const payload = auth?.startsWith("Bearer ")
      ? await verifyToken(c.get("jwtSecret"), auth.slice(7))
      : null;
    if (payload) c.set("uid", payload.uid);
    await next();
  };
}
