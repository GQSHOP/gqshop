/**
 * M5-α 内存限流与登录锁定（ADR-008 A1，审计 M2 收口）。
 * 单实例内存实现（compose 单容器），重启即清零——staging/自用体量足够；分布式留 M6 Redis。
 *   - ipRateLimit(windowMs, max)：公开面 IP 滑动窗口（auth/login、auth/register、admin/login、博客评论）
 *   - loginFailGuard / loginFailRecord：admin 登录失败锁定（uid+IP 双维度，5 次锁 15 分钟）
 */
import type { Context } from "hono";

const buckets = new Map<string, number[]>();

export function clientIp(c: Context): string {
  const xff = c.req.header("x-forwarded-for") ?? "";
  return (xff.split(",")[0] ?? "").trim() || "unknown";
}

/** 滑动窗口计数：超限返回 true（应拒绝）。惰性清理过期桶。 */
function overLimit(key: string, windowMs: number, max: number): boolean {
  const now = Date.now();
  const arr = (buckets.get(key) ?? []).filter((t) => now - t < windowMs);
  if (arr.length >= max) {
    buckets.set(key, arr);
    return true;
  }
  arr.push(now);
  buckets.set(key, arr);
  if (buckets.size > 10_000) {
    // 兜底防内存膨胀：超量全清（重启语义，可接受）
    buckets.clear();
  }
  return false;
}

/** IP 限流中间件工厂。超限 429。 */
export function ipRateLimit(windowMs: number, max: number) {
  return async (c: Context, next: () => Promise<void>) => {
    if (overLimit(`ip:${clientIp(c)}`, windowMs, max)) {
      return c.json({ code: 429, msg: "too many requests" }, 429);
    }
    await next();
  };
}

// ============ admin 登录失败锁定（uid+IP 双维度） ============

interface FailState {
  fails: number;
  lockedUntil: number;
}
const fails = new Map<string, FailState>();
const FAIL_LOCK_THRESHOLD = 5;
const FAIL_LOCK_MS = 15 * 60 * 1000;

/** 命中锁定返回 true（应直接 429 拒绝，不触达 bcrypt）。 */
export function loginFailGuard(username: string, ip: string): boolean {
  const now = Date.now();
  for (const key of [`u:${username}`, `ip:${ip}`]) {
    const st = fails.get(key);
    if (st && st.lockedUntil > now) return true;
  }
  return false;
}

/** 登录失败计数（两维度都记）；达到阈值即锁定。 */
export function loginFailRecord(username: string, ip: string): void {
  const now = Date.now();
  for (const key of [`u:${username}`, `ip:${ip}`]) {
    const st = fails.get(key) ?? { fails: 0, lockedUntil: 0 };
    st.fails += 1;
    if (st.fails >= FAIL_LOCK_THRESHOLD) {
      st.lockedUntil = now + FAIL_LOCK_MS;
      st.fails = 0;
    }
    fails.set(key, st);
  }
}

/** 登录成功清计数。 */
export function loginFailClear(username: string, ip: string): void {
  fails.delete(`u:${username}`);
  fails.delete(`ip:${ip}`);
}
