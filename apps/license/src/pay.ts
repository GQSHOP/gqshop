/**
 * 市场付费流（ADR-012 β）：epay 下单/MD5 验签 notify/settle + license 签发。
 * - epay 协议与 kernel epay.ts 1:1 同构（md5 小写，排除 sign/sign_type/空值，键排序）
 * - license = {payload, sig}：sig=ed25519(canon(payload))，canon=固定构造序的 JSON.stringify
 *   （kernel 侧按相同规则复验——JSON.parse 保留原键序，两侧构造序一致即稳定）
 * - LICENSE 签名私钥=固定挂载点 /srv/secrets/license-signing.pem（与 MARKET 包签名钥分离）
 * - 金额单位=分；商户复用 core 的 epay（订单名带「GQSHOP市场-」前缀便于对账区分）
 */
import { createHash, createPrivateKey, randomBytes, sign as edSign } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { Pool } from "pg";

export const EPAY_TRADE_SUCCESS = "TRADE_SUCCESS";
const LICENSE_KEY_PATH = "/srv/secrets/license-signing.pem";

export interface EpayConfig {
  api: string;
  pid: string;
  key: string;
}

export function epayConfigFromEnv(): EpayConfig | null {
  const api = process.env.GQSHOP_MARKET_EPAY_API ?? "";
  const pid = process.env.GQSHOP_MARKET_EPAY_PID ?? "";
  const key = process.env.GQSHOP_MARKET_EPAY_KEY ?? "";
  if (!api || !pid || !key) return null;
  return { api, pid, key };
}

export function publicBase(): string {
  return (process.env.GQSHOP_MARKET_PUBLIC_BASE ?? "https://license.sc9.top").replace(/\/+$/, "");
}

export function svipPriceCents(): number {
  const n = Number(process.env.GQSHOP_MARKET_SVIP_PRICE_CENTS ?? 0);
  return n > 0 ? Math.floor(n) : 9900; // 默认 ¥99/月
}

/** 平台抽成（基点；未配置=3000 即 30%，ADR-012 A6 初值）。 */
export function platformFeeBps(): number {
  const raw = process.env.GQSHOP_MARKET_PLATFORM_FEE_BPS;
  const n = raw === undefined || raw === "" ? 3000 : Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 10000 ? Math.floor(n) : 3000;
}

// ---------- epay MD5（与 kernel epaySign 同构） ----------

export function epaySign(params: Record<string, string>, merchantKey: string): string {
  const keys = Object.keys(params)
    .filter((k) => k !== "sign" && k !== "sign_type" && params[k] !== "" && params[k] !== undefined)
    .sort();
  const qs = keys.map((k) => `${k}=${params[k]}`).join("&");
  return createHash("md5").update(qs + merchantKey, "utf8").digest("hex");
}

export function epayVerify(params: Record<string, string>, merchantKey: string): boolean {
  const sign = params.sign;
  if (!sign) return false;
  return epaySign(params, merchantKey) === sign.toLowerCase();
}

export function yuan(cents: number): string {
  return (cents / 100).toFixed(2);
}

export function genOrderNo(): string {
  return `MK${Date.now()}${randomBytes(4).toString("hex").toUpperCase()}`;
}

/** 服务端代取支付页 URL（对齐 pay-epay 插件的 submit 形态；禁重定向+限时）。 */
export async function epaySubmitUrl(
  cfg: EpayConfig,
  o: { outTradeNo: string; name: string; amountCents: number },
): Promise<string> {
  const params: Record<string, string> = {
    pid: cfg.pid,
    type: "wap",
    out_trade_no: o.outTradeNo,
    notify_url: `${publicBase()}/api/pay/notify/epay`,
    return_url: `${publicBase()}/console.html`,
    name: o.name.slice(0, 100),
    money: yuan(o.amountCents),
    sitename: "GQSHOP市场",
  };
  const sign = epaySign(params, cfg.key);
  const qs = new URLSearchParams({ ...params, sign, sign_type: "MD5" }).toString();
  return `${cfg.api}/submit.php?${qs}`;
}

// ---------- license 签发 ----------

export interface LicensePayload {
  v: 1;
  type: "plugin" | "svip";
  plugin: string | null;
  licensee: string;
  account: number;
  issued_at: number;
  expires_at: number | null;
  nonce: string;
}

let cachedKey: ReturnType<typeof createPrivateKey> | null = null;
function licenseKey(): ReturnType<typeof createPrivateKey> {
  if (cachedKey) return cachedKey;
  if (!existsSync(LICENSE_KEY_PATH)) {
    throw new Error(`license 签发私钥未挂载（期望 ${LICENSE_KEY_PATH}）`);
  }
  cachedKey = createPrivateKey(readFileSync(LICENSE_KEY_PATH));
  return cachedKey;
}

/** 签发：canon=构造序 stringify（kernel 同规则复验）；返回 {lic 文件内容, payload, sig}。 */
export function issueLicense(
  payloadIn: Omit<LicensePayload, "v" | "issued_at" | "nonce">,
): { file: string; payload: LicensePayload; sig: string } {
  const payload: LicensePayload = {
    v: 1,
    type: payloadIn.type,
    plugin: payloadIn.plugin ?? null,
    licensee: payloadIn.licensee,
    account: payloadIn.account,
    issued_at: Math.floor(Date.now() / 1000),
    expires_at: payloadIn.expires_at ?? null,
    nonce: randomBytes(12).toString("hex"),
  };
  const canon = JSON.stringify(payload);
  const sig = edSign(null, Buffer.from(canon, "utf8"), licenseKey()).toString("base64");
  return { file: JSON.stringify({ payload, sig }), payload, sig };
}

// ---------- settle（notify 验签后调用） ----------

export interface SettleResult {
  ok: boolean;
  msg: string;
  licenseId?: number;
}

export async function settleOrder(pool: Pool, outTradeNo: string, tradeNo: string): Promise<SettleResult> {
  const r = await pool.query<{ id: string; account_id: string; sku_type: string; plugin_name: string | null; licensee: string; amount_cents: number; status: number }>(
    `SELECT id, account_id, sku_type, plugin_name, licensee, amount_cents, status
     FROM market_pay_order WHERE out_trade_no = $1 LIMIT 1`,
    [outTradeNo],
  );
  const o = r.rows[0];
  if (!o) return { ok: false, msg: "order not found" };
  if (o.status === 1) return { ok: true, msg: "already settled" }; // 幂等
  if (o.status !== 0) return { ok: false, msg: `order status ${o.status}` };

  const aid = Number(o.account_id);
  let licenseId: number | undefined;
  if (o.sku_type === "plugin") {
    const lic = issueLicense({ type: "plugin", plugin: o.plugin_name ?? "", licensee: o.licensee, account: aid, expires_at: null });
    const ins = await pool.query<{ id: string }>(
      `INSERT INTO market_license (license_type, plugin_name, licensee, account_id, order_no, payload, sig, issued_at, expires_at)
       VALUES ('plugin', $1, $2, $3, $4, $5, $6, $7, NULL) RETURNING id`,
      [o.plugin_name, o.licensee, aid, outTradeNo, JSON.stringify(lic.payload), lic.sig, lic.payload.issued_at],
    );
    licenseId = Number(ins.rows[0].id);
  } else {
    const expires = Math.floor(Date.now() / 1000) + 30 * 24 * 3600;
    const lic = issueLicense({ type: "svip", plugin: null, licensee: o.licensee, account: aid, expires_at: expires });
    const ins = await pool.query<{ id: string }>(
      `INSERT INTO market_license (license_type, plugin_name, licensee, account_id, order_no, payload, sig, issued_at, expires_at)
       VALUES ('svip', NULL, $1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [o.licensee, aid, outTradeNo, JSON.stringify(lic.payload), lic.sig, lic.payload.issued_at, expires],
    );
    licenseId = Number(ins.rows[0].id);
  }
  await pool.query(
    `UPDATE market_pay_order SET status = 1, trade_no = $1, paid_time = $2 WHERE id = $3`,
    [tradeNo, Date.now(), Number(o.id)],
  );

  // γ：结算落账（sales_record；插件按抽成分成，SVIP 平台自留 dev_net=0）
  const bps = platformFeeBps();
  if (o.sku_type === "plugin") {
    const dev = await pool.query<{ developer_id: string }>(
      `SELECT developer_id FROM market_plugin WHERE name = $1 LIMIT 1`,
      [o.plugin_name ?? ""],
    );
    const devId = Number(dev.rows[0]?.developer_id ?? 0);
    const fee = Math.round(o.amount_cents * bps / 10000);
    await pool.query(
      `INSERT INTO market_sales_record (order_no, plugin_name, developer_id, gross_cents, platform_fee_cents, dev_net_cents, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (order_no) DO NOTHING`,
      [outTradeNo, o.plugin_name ?? "", devId, o.amount_cents, fee, o.amount_cents - fee, Date.now()],
    );
  } else {
    await pool.query(
      `INSERT INTO market_sales_record (order_no, plugin_name, developer_id, gross_cents, platform_fee_cents, dev_net_cents, created_at)
       VALUES ($1, 'svip', 0, $2, $3, 0, $4)
       ON CONFLICT (order_no) DO NOTHING`,
      [outTradeNo, o.amount_cents, o.amount_cents, Date.now()],
    );
  }
  return { ok: true, msg: "settled", licenseId };
}
