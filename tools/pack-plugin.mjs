// GQSHOP 插件市场打包+签名（ADR-011 M1）。
// 用法：node tools/pack-plugin.mjs --dir <插件目录> --key <市场私钥.pem> --out <市场目录>
// 产物：<市场目录>/<name>-<version>.zip + 更新 market-index.json（含 sha256+ed25519 签名）。
// 签名内容：sha256(zip) 的 hex + name + version（UTF-8 拼接）。
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, basename } from "node:path";
import AdmZip from "adm-zip";

const args = process.argv.slice(2);
const get = (k) => { const i = args.indexOf("--" + k); return i >= 0 ? args[i + 1] : undefined; };
const dir = get("dir"), keyPath = get("key"), outDir = get("out");
if (!dir || !keyPath || !outDir) {
  console.error("usage: node tools/pack-plugin.mjs --dir <插件目录> --key <私钥.pem> --out <市场目录>");
  process.exit(1);
}

// plugin.json 必在（name/version/entry）
const meta = JSON.parse(readFileSync(resolve(dir, "plugin.json"), "utf8"));
if (!meta.name || !meta.version) {
  console.error("plugin.json 缺 name/version");
  process.exit(1);
}

// 打包（目录内容平铺进 zip）
const zip = new AdmZip();
for (const f of ["plugin.json", meta.entry ?? "index.js"]) {
  const p = resolve(dir, f);
  if (!existsSync(p)) { console.error("缺文件:", f); process.exit(1); }
  zip.addLocalFile(p);
}
if (meta.assets && Array.isArray(meta.assets)) {
  for (const f of meta.assets) zip.addLocalFile(resolve(dir, f));
}
const buf = zip.toBuffer();
const sha256 = createHash("sha256").update(buf).digest("hex");

// ed25519 签名（sha256hex + name + version）——ed25519 用 keyObject 不走 algorithm 参数
import { createPrivateKey, sign as edSign } from "node:crypto";
const privKey = createPrivateKey(readFileSync(keyPath, "utf8"));
const signature = edSign(null, Buffer.from(sha256 + meta.name + meta.version, "utf8"), privKey).toString("base64");

mkdirSync(outDir, { recursive: true });
const zipName = `${meta.name}-${meta.version}.zip`;
writeFileSync(resolve(outDir, zipName), buf);

// 更新市场清单（同 name 旧版本条目保留=可回滚下载）
const idxPath = resolve(outDir, "market-index.json");
let index = [];
if (existsSync(idxPath)) index = JSON.parse(readFileSync(idxPath, "utf8"));
index = index.filter((e) => !(e.name === meta.name && e.version === meta.version));
index.push({
  name: meta.name,
  version: meta.version,
  description: meta.description ?? "",
  url: zipName,
  sha256,
  signature,
  size: buf.length,
  date: new Date().toISOString(),
});
writeFileSync(idxPath, JSON.stringify(index, null, 2) + "\n");
console.log("packed:", zipName, buf.length, "bytes");
console.log("index entries:", index.length);
