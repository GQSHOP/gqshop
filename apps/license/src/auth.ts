/**
 * 市场账号（ADR-012 A2）：email+bcrypt+独立 JWT（7d）。
 * 引导规则：库内首个注册账号自动 role=admin（运营引导，之后正常 customer）。
 * 限流：内存滑动窗口（登录 10/min、注册 5/min，按 IP）。
 */
import { Hono } from "hono";
import bcrypt from "bcryptjs";
import { sign, verify } from "hono/jwt";
import type { Pool } from "pg";

export interface LicenseEnv {
  Variables: {
    pool: Pool;
    accountId: number;
    accountRole: "customer" | "developer" | "admin";
  };
}

const TOKEN_TTL_SEC = 7 * 24 * 60 * 60;

function jwtSecret(): string {
  return process.env.GQSHOP_LICENSE_JWT_SECRET ?? "";
}

export interface MarketTokenPayload {
  aid: number;
  role: "customer" | "developer" | "admin";
  exp: number;
}

export async function signMarketToken(aid: number, role: MarketTokenPayload["role"]): Promise<string> {
  return await sign({ aid, role, exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SEC }, jwtSecret(), "HS256");
}

export async function verifyMarketToken(token: string): Promise<MarketTokenPayload | null> {
  try {
    const p = (await verify(token, jwtSecret(), "HS256")) as unknown as MarketTokenPayload;
    if (!p.aid || !["customer", "developer", "admin"].includes(p.role)) return null;
    return p;
  } catch {
    return null;
  }
}

/** 内存滑动窗口限流（key=维度，窗口内计数超限=true）。 */
const windows = new Map<string, number[]>();
export function rateLimited(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const arr = (windows.get(key) ?? []).filter((t) => now - t < windowMs);
  if (arr.length >= limit) {
    windows.set(key, arr);
    return true;
  }
  arr.push(now);
  windows.set(key, arr);
  return false;
}

/** 会话中间件：验票 + 实时核账号（封禁/降权即时生效，对齐 core 风格）。 */
export async function sessionMiddleware(c: { req: { header: (k: string) => string | undefined }; set: (k: "accountId" | "accountRole", v: never) => void; get: (k: "pool") => Pool; text: (t: string, s: number) => Response }, next: () => Promise<void>): Promise<Response | void> {
  const auth = c.req.header("Authorization");
  if (!auth?.startsWith("Bearer ")) return c.text("auth required", 401);
  const payload = await verifyMarketToken(auth.slice(7));
  if (!payload) return c.text("invalid token", 401);
  const pool = c.get("pool");
  const r = await pool.query<{ state: number; role: string }>(
    `SELECT state, role FROM market_account WHERE id = $1 LIMIT 1`,
    [payload.aid],
  );
  const row = r.rows[0];
  if (!row || row.state !== 0) return c.text("account unavailable", 401);
  c.set("accountId", payload.aid as never);
  c.set("accountRole", row.role as never);
  await next();
}

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,10}$/;
const PASSWORD_MIN = 8;

export const authRoutes = new Hono<LicenseEnv>();

authRoutes.post("/api/auth/register", async (c) => {
  const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  if (rateLimited(`reg:${ip}`, 5, 60_000)) return c.json({ code: 429, msg: "注册过于频繁" }, 429);
  const body = (await c.req.json().catch(() => null)) as { email?: string; password?: string; display_name?: string } | null;
  const email = String(body?.email ?? "").trim().toLowerCase();
  const password = String(body?.password ?? "");
  const displayName = String(body?.display_name ?? "").slice(0, 64);
  if (!EMAIL_RE.test(email)) return c.json({ code: 400, msg: "email 格式不合法" }, 400);
  if (password.length < PASSWORD_MIN) return c.json({ code: 400, msg: `密码至少 ${PASSWORD_MIN} 位` }, 400);
  const pool = c.get("pool");
  const dup = await pool.query(`SELECT 1 FROM market_account WHERE email = $1 LIMIT 1`, [email]);
  if (dup.rowCount) return c.json({ code: 409, msg: "email 已注册" }, 409);
  const count = await pool.query<{ cnt: string }>(`SELECT COUNT(*) AS cnt FROM market_account`);
  const isFirst = Number(count.rows[0].cnt) === 0;
  const hash = bcrypt.hashSync(password, 10);
  // 审查修复 L：dup 检查与 INSERT 之间并发同 email → 唯一约束 23505（409 而非 500）
  let r: { rows: Array<{ id: string }> };
  try {
    r = await pool.query<{ id: string }>(
      `INSERT INTO market_account (email, password_hash, display_name, role, created_at)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [email, hash, displayName, isFirst ? "admin" : "customer", Date.now()],
    );
  } catch (e) {
    if (String((e as { code?: string }).code) === "23505") {
      return c.json({ code: 409, msg: "email 已注册" }, 409);
    }
    throw e;
  }
  const role = isFirst ? "admin" : "customer";
  const token = await signMarketToken(Number(r.rows[0].id), role);
  return c.json({ code: 0, data: { token, role, first_admin: isFirst } }, 201);
});

authRoutes.post("/api/auth/login", async (c) => {
  const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  if (rateLimited(`login:${ip}`, 10, 60_000)) return c.json({ code: 429, msg: "尝试过于频繁，请稍后再试" }, 429);
  const body = (await c.req.json().catch(() => null)) as { email?: string; password?: string } | null;
  const email = String(body?.email ?? "").trim().toLowerCase();
  const password = String(body?.password ?? "");
  if (!email || !password) return c.json({ code: 400, msg: "email/password required" }, 400);
  const pool = c.get("pool");
  const r = await pool.query<{ id: string; password_hash: string; role: string; state: number; display_name: string }>(
    `SELECT id, password_hash, role, state, display_name FROM market_account WHERE email = $1 LIMIT 1`,
    [email],
  );
  const u = r.rows[0];
  // 统一 401（不区分不存在/密码错/封禁，避免账号枚举）
  if (!u || u.state !== 0 || !bcrypt.compareSync(password, u.password_hash)) {
    return c.json({ code: 401, msg: "invalid credentials" }, 401);
  }
  const token = await signMarketToken(Number(u.id), u.role as "customer" | "developer" | "admin");
  return c.json({ code: 0, data: { token, role: u.role, display_name: u.display_name } });
});

authRoutes.get("/api/me", sessionMiddleware, async (c) => {
  const pool = c.get("pool");
  const r = await pool.query<{ email: string; display_name: string; role: string; dev_pending: boolean; created_at: string }>(
    `SELECT email, display_name, role, dev_pending, created_at FROM market_account WHERE id = $1 LIMIT 1`,
    [c.get("accountId")],
  );
  const u = r.rows[0];
  if (!u) return c.json({ code: 404, msg: "account gone" }, 404);
  return c.json({ code: 0, data: { ...u, id: c.get("accountId") } });
});
