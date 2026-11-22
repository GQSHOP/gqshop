// GQSHOP 市场密钥生成（ADR-011 M1）：ed25519 对。
// 用法：node tools/market-keys.mjs [--out-dir .keys]
// 私钥=市场方持有（不入库）；公钥=编译进 kernel MARKET_PUBKEY（spki/base64）。
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { resolve } from "node:path";

const outDir = resolve(process.argv[2] ?? process.argv[3] ?? ".market-keys");
mkdirSync(outDir, { recursive: true });
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const privPem = privateKey.export({ type: "pkcs8", format: "pem" });
const pubB64 = publicKey.export({ type: "spki", format: "der" }).toString("base64");
writeFileSync(resolve(outDir, "market-private.pem"), privPem);
chmodSync(resolve(outDir, "market-private.pem"), 0o600);
writeFileSync(resolve(outDir, "market-public.txt"), pubB64 + "\n");
console.log("private:", resolve(outDir, "market-private.pem"), "(600, 市场方保管，勿入库)");
console.log("public (base64 spki):", pubB64);
console.log("→ 填入 packages/kernel/plugin-market.ts 的 MARKET_PUBKEY");
