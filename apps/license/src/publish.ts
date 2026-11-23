/**
 * 签包发布（ADR-012 A3/A5）：审核通过 → 服务端 ed25519 签名（对齐 kernel 验签：
 * sha256+name+version）→ zip 落 GQSHOP_MARKET_DIR → market-index.json 原子再生。
 * 私钥经固定挂载点读取（容器 /srv/secrets/market-signing.pem，compose ro 挂载，
 * 600 宿主权限）——不落库、不进镜像、不经 env 传路径。
 * 落盘文件名=内容 sha256（内容寻址）：用户可控的 name/version 只进 index 元数据，
 * 永不进入文件系统路径——路径穿越在构造上不可能（比过滤更硬的保证）。
 */
import { createHash, createPrivateKey, sign as edSign } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

interface MarketIndexEntry {
  name: string;
  version: string;
  description: string;
  url: string;
  sha256: string;
  signature: string;
  size: number;
  date: string;
  paid?: boolean; // β：付费插件标记（老 kernel 忽略未知字段，向后兼容）
}

/** 读当前市场清单（损坏/缺失返回空数组——只读视图用）。 */
export function readMarketIndex(): MarketIndexEntry[] {
  const indexPath = join(marketDir(), INDEX_NAME);
  if (!existsSync(indexPath)) return [];
  try {
    const parsed = JSON.parse(readFileSync(indexPath, "utf8")) as unknown;
    return Array.isArray(parsed) ? (parsed as MarketIndexEntry[]) : [];
  } catch {
    return [];
  }
}

const INDEX_NAME = "market-index.json";
/** 签名私钥固定挂载点（部署契约：宿主 600 文件 → 容器只读挂载于此）。 */
const SIGNING_KEY_PATH = "/srv/secrets/market-signing.pem";

export function marketDir(): string {
  return process.env.GQSHOP_MARKET_DIR ?? "./data/market";
}

let cachedKey: ReturnType<typeof createPrivateKey> | null = null;
function signingKey(): ReturnType<typeof createPrivateKey> {
  if (cachedKey) return cachedKey;
  if (!existsSync(SIGNING_KEY_PATH)) {
    throw new Error(`签包私钥未挂载（期望 ${SIGNING_KEY_PATH}）`);
  }
  cachedKey = createPrivateKey(readFileSync(SIGNING_KEY_PATH));
  return cachedKey;
}

/** 发布一个包：签名 + 内容寻址落盘 + index 原子更新。返回新 index 条目（paid=付费标记）。 */
export function publishPackage(zipBuf: Buffer, name: string, version: string, description: string, paid = false): MarketIndexEntry {
  if (!/^[a-z][a-z0-9_]{2,49}$/.test(name) || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`非法 name/version: ${name}@${version}`);
  }
  const sha256 = createHash("sha256").update(zipBuf).digest("hex");
  // 与 kernel plugin-market verifySignature 完全同构：Sign(priv, sha256+name+version)
  const signature = edSign(null, Buffer.from(sha256 + name + version, "utf8"), signingKey()).toString("base64");
  const dir = resolve(marketDir());
  const fileName = `${sha256}.zip`; // 纯十六进制内容寻址，无用户输入

  // zip 落盘（tmp+rename 原子化，nginx 静态读侧无半文件窗口）
  const zipTmp = join(dir, `.${sha256}.tmp`);
  const zipFinal = join(dir, fileName);
  if (!zipTmp.startsWith(dir) || !zipFinal.startsWith(dir)) {
    throw new Error("发布路径越界");
  }
  writeFileSync(zipTmp, zipBuf);
  renameSync(zipTmp, zipFinal);

  // index 再生：读旧 → 去同插件同版本（含旧命名的历史条目）→ 追加 → 原子写
  const indexPath = join(dir, INDEX_NAME);
  let list: MarketIndexEntry[] = [];
  if (existsSync(indexPath)) {
    try {
      const parsed = JSON.parse(readFileSync(indexPath, "utf8")) as unknown;
      if (Array.isArray(parsed)) list = parsed as MarketIndexEntry[];
    } catch {
      list = []; // 损坏则重建（包文件仍在，index 是衍生物）
    }
  }
  list = list.filter((e) => !(e?.name === name && e?.version === version));
  const entry: MarketIndexEntry = {
    name,
    version,
    description: description.slice(0, 500),
    url: fileName,
    sha256,
    signature,
    size: zipBuf.length,
    date: new Date().toISOString(),
    ...(paid ? { paid: true } : {}),
  };
  list.push(entry);
  const idxTmp = join(dir, `.index.tmp`);
  writeFileSync(idxTmp, JSON.stringify(list, null, 2));
  renameSync(idxTmp, indexPath);
  console.log(`[license] 已发布 ${name}@${version}（sha256=${sha256.slice(0, 12)}… index 共 ${list.length} 条）`);
  return entry;
}

/** γ：下架——从 index 原子移除该插件全部版本（zip 保留；已装实例不回收，只挡新装/升级）。 */
export function unpublishPlugin(name: string): number {
  if (!/^[a-z][a-z0-9_]{2,49}$/.test(name)) throw new Error(`非法 name: ${name}`);
  const dir = resolve(marketDir());
  const indexPath = join(dir, INDEX_NAME);
  const list = readMarketIndex();
  const kept = list.filter((e) => e?.name !== name);
  if (kept.length === list.length) return 0; // 无此插件
  const idxTmp = join(dir, `.index.tmp`);
  writeFileSync(idxTmp, JSON.stringify(kept, null, 2));
  renameSync(idxTmp, indexPath);
  console.log(`[license] 已下架 ${name}（移除 ${list.length - kept.length} 条）`);
  return list.length - kept.length;
}
