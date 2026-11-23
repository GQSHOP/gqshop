/**
 * auto_scan（ADR-012 A3）：提交期静态门——全部只读检查，产出报告；不过门直接拒。
 * 检查项：zip 结构/体积/条目上限、zip-slip、plugin.json 白名单（对齐 kernel 安装期校验）、
 * 入口语法（node --check .mjs 临时文件，execFile 固定程序+固定 argv）、敏感 API 使用披露清单。
 */
import AdmZip from "adm-zip";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const MAX_ZIP_BYTES = 2 * 1024 * 1024;
export const MAX_ENTRIES = 64;
export const MAX_UNCOMPRESSED_BYTES = 8 * 1024 * 1024;
export const NAME_RE = /^[a-z][a-z0-9_]{2,49}$/;
export const VERSION_RE = /^\d+\.\d+\.\d+$/;

export interface ScanReport {
  pass: boolean;
  reason?: string;
  entry_count: number;
  uncompressed_bytes: number;
  manifest: { name: string; version: string; entry: string; description: string } | null;
  usage: Record<string, number>;
}

/** 敏感 API 披露计数（进程内信任模型 S1 的前置披露——不阻断，附给人工审）。 */
const USAGE_PATTERNS: Array<[string, RegExp]> = [
  ["process.env", /process\.env/g],
  ["node:fs/fs", /require\(["']node:fs|from ["']node:fs|require\(["']fs["']\)/g],
  ["child_process", /child_process/g],
  ["net", /require\(["']node:net|from ["']node:net|require\(["']net["']\)/g],
  ["http(s)", /require\(["']node:https?|from ["']node:https?|https?:\/\/(?!license\.sc9\.top)/g],
  ["eval/Function", /\beval\(|new Function\(/g],
];

export async function autoScan(zipBuf: Buffer, expectName: string, expectVersion: string): Promise<ScanReport> {
  const report: ScanReport = { pass: false, entry_count: 0, uncompressed_bytes: 0, manifest: null, usage: {} };
  if (zipBuf.length > MAX_ZIP_BYTES) {
    report.reason = `zip 超 2MB（${zipBuf.length}）`;
    return report;
  }
  if (zipBuf.subarray(0, 2).toString("latin1") !== "PK") {
    report.reason = "非 zip 文件（缺 PK 魔数）";
    return report;
  }
  let zip: AdmZip;
  try {
    zip = new AdmZip(zipBuf);
  } catch {
    report.reason = "zip 解析失败";
    return report;
  }
  const entries = zip.getEntries().filter((e) => !e.isDirectory);
  report.entry_count = entries.length;
  if (entries.length === 0 || entries.length > MAX_ENTRIES) {
    report.reason = `条目数 ${entries.length} 超限（1-${MAX_ENTRIES}）`;
    return report;
  }
  let total = 0;
  for (const e of entries) {
    const n = e.entryName.replace(/\\/g, "/");
    if (n.startsWith("/") || n.split("/").includes("..") || !/^[a-zA-Z0-9_./-]+$/.test(n)) {
      report.reason = `zip-slip 可疑条目: ${n}`;
      return report;
    }
    total += e.header.size;
  }
  report.uncompressed_bytes = total;
  if (total > MAX_UNCOMPRESSED_BYTES) {
    report.reason = `解压后超 8MB（${total}）`;
    return report;
  }
  const manifestEntry = zip.getEntry("plugin.json");
  if (!manifestEntry) {
    report.reason = "包内缺 plugin.json";
    return report;
  }
  let meta: Record<string, unknown>;
  try {
    meta = JSON.parse(manifestEntry.getData().toString("utf8")) as Record<string, unknown>;
  } catch {
    report.reason = "plugin.json 非法 JSON";
    return report;
  }
  if (meta.name !== expectName) {
    report.reason = "plugin.json name 与提交不一致";
    return report;
  }
  if (String(meta.version ?? "") !== expectVersion) {
    report.reason = "plugin.json version 与提交不一致";
    return report;
  }
  const entryFile = typeof meta.entry === "string" && /^[a-zA-Z0-9_.-]+$/.test(meta.entry) ? meta.entry : "index.js";
  const entryZip = zip.getEntry(entryFile);
  if (!entryZip) {
    report.reason = `包内缺入口 ${entryFile}`;
    return report;
  }
  const description = String(meta.description ?? "").slice(0, 500);
  report.manifest = { name: expectName, version: expectVersion, entry: entryFile, description };

  // 入口语法检查（临时 .mjs → node --check；文件名为服务端随机值，非用户可控）
  const code = entryZip.getData().toString("utf8");
  const dir = mkdtempSync(join(tmpdir(), "gqscan-"));
  try {
    const tmp = join(dir, `${randomBytes(8).toString("hex")}.mjs`);
    writeFileSync(tmp, code);
    await execFileAsync("node", ["--check", tmp], { timeout: 10_000 });
  } catch (err) {
    report.reason = `入口语法检查失败: ${String((err as Error & { stderr?: string }).stderr ?? err).slice(0, 200)}`;
    return report;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  for (const [label, re] of USAGE_PATTERNS) {
    const hits = code.match(re)?.length ?? 0;
    if (hits > 0) report.usage[label] = hits;
  }
  report.pass = true;
  return report;
}
