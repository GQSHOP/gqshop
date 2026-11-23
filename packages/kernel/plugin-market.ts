/**
 * 应用市场：插件分发/验签/安装/版本管理（ADR-011 M2/M3）。
 * 安全链：sha256 校验 + ed25519 验签（公钥编译进内核）+ zip-slip 防护 +
 * plugin.json 结构白名单校验。安装/升级/回滚均落 data/plugins/{name}/{version}/，
 * 指针 installed.json；变更后需重启生效（S1 不热加载）。
 */
import { createHash, createPublicKey, verify as cryptoVerify } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

import AdmZip from "adm-zip";

/** 市场公钥（spki/der/base64）——轮换=发版（ADR-011 M1）。 */
export const MARKET_PUBKEY =
  process.env.GQSHOP_MARKET_PUBKEY ??
  "MCowBQYDK2VwAyEA placeholder-replace-at-E2E-keygen 0";

export interface MarketEntry {
  name: string;
  version: string;
  description: string;
  url: string;
  sha256: string;
  signature: string;
  size: number;
  date: string;
  /** β（ADR-012 A4）：付费插件——安装/升级需本地有效 license（ed25519 验签+域名匹配）。 */
  paid?: boolean;
}

// ============ β：付费插件 license 验证（ADR-012 A4） ============

/** license 公钥（spki/der/base64，与市场 LICENSE 签发钥配对；轮换=发版+存量重签）。 */
export const LICENSE_PUBKEY = process.env.GQSHOP_LICENSE_PUBKEY ?? "";

interface LicensePayload {
  v: number;
  type: "plugin" | "svip";
  plugin: string | null;
  licensee: string;
  account: number;
  issued_at: number;
  expires_at: number | null;
  nonce: string;
}

export function licensesDir(): string {
  return process.env.GQSHOP_LICENSES_DIR ?? "./data/licenses";
}

function licenseFilePath(plugin: string): string {
  return join(licensesDir(), `${plugin.replace(/[^a-z0-9_]/g, "")}.lic`);
}

function thisSiteHost(): string | null {
  const base = process.env.GQSHOP_PUBLIC_BASE ?? "";
  try {
    return new URL(base).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** SVIP 兜底：data/licenses/svip.lic（任一 SVIP 过期校验通过即放行全部付费插件）。 */
function verifyLicenseObject(parsed: { payload?: unknown; sig?: unknown }, plugin: string, now: number): { ok: boolean; msg: string } {
  if (!LICENSE_PUBKEY) return { ok: false, msg: "未配置 GQSHOP_LICENSE_PUBKEY（无法校验付费插件 license）" };
  const payload = parsed.payload as LicensePayload | undefined;
  const sig = typeof parsed.sig === "string" ? parsed.sig : "";
  if (!payload || !sig) return { ok: false, msg: "license 文件格式不合法" };
  // 验签：canon=解析后原键序 stringify（与市场签发侧构造序一致）
  let valid = false;
  try {
    const pub = createPublicKey({ key: Buffer.from(LICENSE_PUBKEY, "base64"), format: "der", type: "spki" });
    valid = cryptoVerify(null, Buffer.from(JSON.stringify(payload), "utf8"), pub, Buffer.from(sig, "base64"));
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, msg: "license 验签失败" };
  if (payload.expires_at !== null && payload.expires_at <= now) return { ok: false, msg: "license 已过期" };
  const host = thisSiteHost();
  if (!host || payload.licensee.toLowerCase() !== host) {
    return { ok: false, msg: `license 域名不匹配（授权给 ${payload.licensee}，本站 ${host ?? "未配置 PUBLIC_BASE"}）` };
  }
  const covers = payload.type === "svip" || (payload.type === "plugin" && payload.plugin === plugin);
  if (!covers) return { ok: false, msg: `license 不覆盖插件 ${plugin}` };
  return { ok: true, msg: "ok" };
}

/** 付费门：data/licenses/{plugin}.lic 或 svip.lic 任一有效即放行；导出供 admin 导入时复验。 */
export function requirePluginLicense(plugin: string): { ok: boolean; msg: string; content?: string } {
  const now = Math.floor(Date.now() / 1000);
  for (const f of [licenseFilePath(plugin), join(licensesDir(), "svip.lic")]) {
    if (!existsSync(f)) continue;
    try {
      const parsed = JSON.parse(readFileSync(f, "utf8")) as { payload?: unknown; sig?: unknown };
      const r = verifyLicenseObject(parsed, plugin, now);
      if (r.ok) return { ...r, content: readFileSync(f, "utf8") };
      return { ok: false, msg: `${f}: ${r.msg}` };
    } catch {
      return { ok: false, msg: `${f}: 解析失败` };
    }
  }
  return { ok: false, msg: `付费插件 ${plugin} 需要有效 license（市场购买后经 admin 导入，或放置 ${licenseFilePath(plugin)}）` };
}

export interface MarketSource {
  fetchIndex(): Promise<MarketEntry[]>;
  fetchPackage(entry: MarketEntry): Promise<Buffer>;
}

/** 本地市场源（M6-α）：GQSHOP_MARKET_DIR 目录（仅 owner 可写，部署文档注明）。 */
export class LocalMarketSource implements MarketSource {
  constructor(private dir: string) {}
  async fetchIndex(): Promise<MarketEntry[]> {
    const p = join(this.dir, "market-index.json");
    if (!existsSync(p)) return [];
    return JSON.parse(readFileSync(p, "utf8")) as MarketEntry[];
  }
  async fetchPackage(entry: MarketEntry): Promise<Buffer> {
    return readFileSync(join(this.dir, entry.url.replace(/[^a-zA-Z0-9_.-]/g, "")));
  }
}

/** HTTP 市场源（M6-β）：GQSHOP_MARKET_URL（过 SSRF 防线）。 */
export class HttpMarketSource implements MarketSource {
  constructor(private base: string) {}
  async fetchIndex(): Promise<MarketEntry[]> {
    const u = new URL("market-index.json", this.base);
    const r = await fetch(u, { signal: AbortSignal.timeout(15000), redirect: "error" });
    if (!r.ok) throw new Error(`market index http ${r.status}`);
    return (await r.json()) as MarketEntry[];
  }
  async fetchPackage(entry: MarketEntry): Promise<Buffer> {
    const u = new URL(entry.url.replace(/[^a-zA-Z0-9_.-]/g, ""), this.base);
    const r = await fetch(u, { signal: AbortSignal.timeout(60000), redirect: "error" });
    if (!r.ok) throw new Error(`market package http ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  }
}

export function marketSourceFromEnv(): MarketSource | null {
  const dir = process.env.GQSHOP_MARKET_DIR;
  if (dir && existsSync(dir)) return new LocalMarketSource(dir);
  const url = process.env.GQSHOP_MARKET_URL;
  if (url) return new HttpMarketSource(url);
  return null;
}

export interface InstalledRecord {
  name: string;
  version: string;
  installedAt: number;
}

function pluginsRoot(): string {
  return process.env.GQSHOP_PLUGINS_DIR ?? "./data/plugins";
}

function installedIndexPath(): string {
  return join(pluginsRoot(), "installed.json");
}

export function listInstalled(): InstalledRecord[] {
  const p = installedIndexPath();
  if (!existsSync(p)) return [];
  try {
    return JSON.parse(readFileSync(p, "utf8")) as InstalledRecord[];
  } catch {
    return [];
  }
}

function saveInstalled(list: InstalledRecord[]): void {
  mkdirSync(pluginsRoot(), { recursive: true });
  writeFileSync(installedIndexPath(), JSON.stringify(list, null, 2) + "\n");
}

/** 验签：sha256hex + name + version 的 ed25519 签名。 */
function verifySignature(buf: Buffer, entry: MarketEntry): boolean {
  try {
    const pub = createPublicKey({ key: Buffer.from(MARKET_PUBKEY, "base64"), format: "der", type: "spki" });
    const data = entry.sha256 + entry.name + entry.version;
    return cryptoVerify(null, Buffer.from(data, "utf8"), pub, Buffer.from(entry.signature, "base64"));
  } catch {
    return false;
  }
}

/** plugin.json 结构白名单校验（ADR-011 M3）。 */
function validateManifest(meta: unknown, entry: MarketEntry): { name: string; version: string; entry: string } {
  if (!meta || typeof meta !== "object") throw new Error("plugin.json 非对象");
  const m = meta as Record<string, unknown>;
  if (m.name !== entry.name) throw new Error("plugin.json name 与清单不一致");
  if (String(m.version ?? "") !== entry.version) throw new Error("plugin.json version 与清单不一致");
  const entryFile = typeof m.entry === "string" && /^[a-zA-Z0-9_.-]+$/.test(m.entry) ? m.entry : "index.js";
  return { name: m.name as string, version: entry.version, entry: entryFile };
}

export interface InstallResult {
  installed: true;
  name: string;
  version: string;
  restartRequired: true;
}

/** 安装/升级：下载→双验→解压（zip-slip 防护）→校验→落目录→指针+active_plugins。 */
export async function installPlugin(
  pool: import("pg").Pool | import("pg").PoolClient,
  source: MarketSource,
  name: string,
  version?: string,
): Promise<InstallResult> {
  const index = await source.fetchIndex();
  const candidates = index.filter((e) => e.name === name);
  if (candidates.length === 0) throw new Error(`market 无此插件: ${name}`);
  const entry = version
    ? candidates.find((e) => e.version === version)
    : candidates.sort((a, b) => b.date.localeCompare(a.date))[0];
  if (!entry) throw new Error(`market 无版本 ${name}@${version}`);

  // β（ADR-012 A4）：付费门——安装/升级前校验本地 license（已装不回收：只挡新装与升级）
  if (entry.paid === true) {
    const lic = requirePluginLicense(name);
    if (!lic.ok) throw new Error(lic.msg);
  }

  const buf = await source.fetchPackage(entry);
  const sha256 = createHash("sha256").update(buf).digest("hex");
  if (sha256 !== entry.sha256) throw new Error("sha256 校验失败");
  if (!verifySignature(buf, entry)) throw new Error("ed25519 验签失败");

  const zip = new AdmZip(buf);
  const manifestEntry = zip.getEntry("plugin.json");
  if (!manifestEntry) throw new Error("包内缺 plugin.json");
  const meta = validateManifest(JSON.parse(manifestEntry.getData().toString("utf8")), entry);

  // 解压（zip-slip：拒绝绝对路径/.. 与白名单外文件名）
  const dest = join(pluginsRoot(), name, entry.version);
  mkdirSync(dest, { recursive: true });
  for (const e of zip.getEntries()) {
    const n = e.entryName.replace(/\\/g, "/");
    if (n.startsWith("/") || n.split("/").includes("..") || !/^[a-zA-Z0-9_./-]+$/.test(n)) {
      throw new Error(`zip-slip 可疑条目: ${n}`);
    }
    if (e.isDirectory) continue;
    const target = resolve(dest, n);
    if (!target.startsWith(resolve(dest))) throw new Error(`zip-slip: ${n}`);
    writeFileSync(target, e.getData());
  }
  if (!existsSync(join(dest, meta.entry))) throw new Error(`包内缺入口 ${meta.entry}`);

  // 指针 + active_plugins 更新（装即启用）
  const list = listInstalled().filter((r) => r.name !== name);
  list.push({ name, version: entry.version, installedAt: Date.now() });
  saveInstalled(list);
  await enableInActivePlugins(pool, name);

  return { installed: true, name, version: entry.version, restartRequired: true };
}

async function enableInActivePlugins(
  pool: import("pg").Pool | import("pg").PoolClient,
  name: string,
): Promise<void> {
  const r = await pool.query<{ option_value: string }>(
    `SELECT option_value FROM gq_options WHERE option_name = 'active_plugins' LIMIT 1`,
  );
  let arr: string[] | null = null; // null = option 不存在（全开语义）
  if (r.rows[0]) {
    try {
      const parsed = JSON.parse(r.rows[0].option_value) as unknown;
      if (Array.isArray(parsed)) arr = parsed.map(String);
    } catch {
      arr = null;
    }
  }
  if (arr === null) {
    // 全开语义保护：写入全部内置插件 + 新插件（勿把"全开"窄化为单插件）
    const { BUILTIN_PLUGINS } = await import("./plugin-host.js");
    arr = BUILTIN_PLUGINS.map((d) => d.name);
  }
  arr = [...new Set([...arr.filter((n) => n !== name), name])];
  await pool.query(
    `INSERT INTO gq_options (option_name, option_value) VALUES ('active_plugins', $1)
     ON CONFLICT (option_name) DO UPDATE SET option_value = $1`,
    [JSON.stringify(arr)],
  );
}

/** 回滚：指针切回本地已有版本目录（零下载）。 */
export async function rollbackPlugin(name: string, version: string): Promise<InstallResult> {
  // 审查修复 M2：name/version 进文件路径——白名单正则防穿越（admin 面纵深防线）
  if (!/^[a-z][a-z0-9_]{2,49}$/.test(name) || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`非法 name/version: ${name}@${version}`);
  }
  const dir = join(pluginsRoot(), name, version);
  if (!existsSync(join(dir, "plugin.json"))) throw new Error(`本地无版本 ${name}@${version}`);
  const list = listInstalled().filter((r) => r.name !== name);
  list.push({ name, version, installedAt: Date.now() });
  saveInstalled(list);
  return { installed: true, name, version, restartRequired: true };
}

/** 卸载：移指针+目录+active_plugins（移除后若与内置集一致则删 option 恢复全开语义）。 */
export async function uninstallPlugin(
  pool: import("pg").Pool | import("pg").PoolClient,
  name: string,
): Promise<void> {
  // 审查修复 M2：rmSync 递归删除前白名单校验（防 admin 面 name 路径穿越删除任意目录）
  if (!/^[a-z][a-z0-9_]{2,49}$/.test(name)) {
    throw new Error(`非法 name: ${name}`);
  }
  rmSync(join(pluginsRoot(), name), { recursive: true, force: true });
  saveInstalled(listInstalled().filter((r) => r.name !== name));
  const r = await pool.query<{ option_value: string }>(
    `SELECT option_value FROM gq_options WHERE option_name = 'active_plugins' LIMIT 1`,
  );
  let arr: string[] = [];
  try {
    arr = JSON.parse(r.rows[0]?.option_value ?? "[]");
    if (!Array.isArray(arr)) arr = [];
  } catch {
    arr = [];
  }
  const next = [...new Set(arr.filter((n) => n !== name))];
  const { BUILTIN_PLUGINS } = await import("./plugin-host.js");
  const builtinSet = new Set(BUILTIN_PLUGINS.map((d) => d.name));
  const onlyBuiltins = next.length > 0 && next.every((n) => builtinSet.has(n));
  if (onlyBuiltins && next.length === builtinSet.size) {
    // 移除后恰为全内置集 → 删 option 回到"不存在=全开"语义（防空数组误杀全部插件）
    await pool.query(`DELETE FROM gq_options WHERE option_name = 'active_plugins'`);
    return;
  }
  await pool.query(
    `INSERT INTO gq_options (option_name, option_value) VALUES ('active_plugins', $1)
     ON CONFLICT (option_name) DO UPDATE SET option_value = $1`,
    [JSON.stringify(next)],
  );
}

/** 市场视图：清单+已装+可升级差集。 */
export async function marketView(source: MarketSource): Promise<{
  index: MarketEntry[];
  installed: InstalledRecord[];
  upgradable: Array<{ name: string; from: string; to: string }>;
}> {
  const index = await source.fetchIndex();
  const installed = listInstalled();
  const upgradable: Array<{ name: string; from: string; to: string }> = [];
  for (const rec of installed) {
    const latest = index
      .filter((e) => e.name === rec.name)
      .sort((a, b) => b.date.localeCompare(a.date))[0];
    if (latest && latest.version !== rec.version) {
      upgradable.push({ name: rec.name, from: rec.version, to: latest.version });
    }
  }
  return { index, installed, upgradable };
}

/** 已装版本目录（回滚候选）。 */
export function localVersions(name: string): string[] {
  const dir = join(pluginsRoot(), name);
  if (!existsSync(dir)) return [];
  const { readdirSync, statSync } = require("node:fs") as typeof import("node:fs");
  return readdirSync(dir).filter((v) => statSync(join(dir, v)).isDirectory() && existsSync(join(dir, v, "plugin.json")));
}
