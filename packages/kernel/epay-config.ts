/**
 * 易支付协议公共配置（网关/商户），凭据仅从环境变量读取，绝不入库。
 * 网关 URL 启动时校验：仅 http/https，拒绝环回/内网/保留地址（SSRF 防护）。
 */
export interface EpayConfig {
  api: string;
  pid: string;
  key: string;
}

const BLOCKED_HOSTNAMES = new Set(["localhost", "metadata", "internal"]);

function isPrivateIpv4(host: string): boolean {
  const octets = host.split(".").map((n) => Number(n));
  if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return false;
  }
  const [a, b] = octets as [number, number, number, number];
  if (a === 127 || a === 10 || a === 0 || a === 169 || a === 100) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}

/** IPv6 私有/保留字面量（M5-α 审计 M1 收口：::1、v4 映射 ::ffff:0:0/96、fc00::/7、fe80::/10、未指定）。 */
function isPrivateIpv6(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (!h.includes(":")) return false;
  // IPv4 映射地址 ::ffff:a.b.c.d → 递归 IPv4 判定
  const mapped = h.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped?.[1]) return isPrivateIpv4(mapped[1]);
  if (h === "::" || h === "::1") return true; // 未指定 / 环回
  // 非 "::" 前缀但仍是纯 IPv6：取首组判断 fc00::/7（fc/fd 开头）与 fe80::/10（链路本地）
  const firstGroup = parseInt(h.split(":")[0] || "0", 16);
  if (!Number.isNaN(firstGroup)) {
    if ((firstGroup & 0xfe00) === 0xfc00) return true; // fc00::/7 唯一本地
    if ((firstGroup & 0xffc0) === 0xfe80) return true; // fe80::/10 链路本地
    if ((firstGroup & 0xff00) === 0xff00) return true; // ff00::/8 组播
  }
  return false;
}

function isPrivateHost(host: string): boolean {
  return isPrivateIpv4(host) || isPrivateIpv6(host);
}

/** 校验并规范化网关 URL；不合规直接抛错（fail-fast，不允许静默降级）。 */
export function parseGatewayUrl(raw: string): string {
  const v = raw.trim();
  if (!/^https?:\/\//i.test(v)) {
    throw new Error(`epay gateway must be an http or https URL`);
  }
  const u = new URL(v);
  const host = u.hostname.toLowerCase();
  if (
    BLOCKED_HOSTNAMES.has(host) ||
    isPrivateHost(host) ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  ) {
    throw new Error(`epay gateway host not allowed: ${host}`);
  }
  return v.replace(/\/+$/, "");
}

/** 服务端发起请求前的最终防线：目标 URL 必须是公网 http(s) 地址（含重定向防护语义）。 */
export function assertPublicHttpUrl(url: string): URL {
  const u = new URL(url);
  const proto = u.protocol.toLowerCase();
  if (proto !== "http:" && proto !== "https:") {
    throw new Error(`blocked non-http(s) request target: ${proto}`);
  }
  const host = u.hostname.toLowerCase();
  if (
    BLOCKED_HOSTNAMES.has(host) ||
    isPrivateHost(host) ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  ) {
    throw new Error(`blocked request to private/reserved host: ${host}`);
  }
  return u;
}

export function epayConfigFromEnv(env: NodeJS.ProcessEnv = process.env): EpayConfig | null {
  if (!env.GQSHOP_EPAY_API || !env.GQSHOP_EPAY_PID || !env.GQSHOP_EPAY_KEY) {
    return null;
  }
  return {
    api: parseGatewayUrl(env.GQSHOP_EPAY_API),
    pid: env.GQSHOP_EPAY_PID,
    key: env.GQSHOP_EPAY_KEY,
  };
}

/** 公网基址（notify/return URL 构建用）。 */
export function publicBaseFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  return parseGatewayUrl(env.GQSHOP_PUBLIC_BASE ?? "http://127.0.0.1:8100");
}
