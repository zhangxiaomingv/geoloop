#!/usr/bin/env node
/**
 * 激活码管理 CLI（方案 A 付费门禁）
 *
 * 用法：
 *   node scripts/gen-license.mjs [客户名] [天数]     生成激活码（无天数=永久）
 *   node scripts/gen-license.mjs --list              列出全部激活码
 *   node scripts/gen-license.mjs --revoke CODE       吊销激活码
 *   node scripts/gen-license.mjs --revoke-expired    吊销所有已过期的
 *
 * 示例：
 *   node scripts/gen-license.mjs "张晓明" 30
 *   node scripts/gen-license.mjs "测试客户"          # 永久
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FILE = path.join(here, "data", "licenses.json");

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 去掉 I O 0 1
const seg = () => Array.from({ length: 4 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join("");

function load() {
  if (!existsSync(FILE)) return [];
  try { return JSON.parse(readFileSync(FILE, "utf-8")); } catch { return []; }
}
function save(list) {
  writeFileSync(FILE, JSON.stringify(list, null, 2));
}

function makeCode(note, days) {
  const lic = {
    code: `GEO-${seg()}-${seg()}-${seg()}`,
    status: "active",
    expiresAt: days && days > 0 ? new Date(Date.now() + days * 86400_000).toISOString() : null,
    note,
    createdAt: new Date().toISOString(),
    usedAt: null,
  };
  const list = load();
  list.push(lic);
  save(list);
  return lic;
}

function listAll() {
  const list = load().slice().reverse(); // 新的在前
  if (!list.length) { console.log("（空）还没有激活码"); return; }
  console.log("状态      激活码                 到期            首次使用        备注");
  for (const l of list) {
    const st = l.status === "active" ? "✓ 有效" : "✗ 吊销";
    const exp = l.expiresAt ? l.expiresAt.slice(0, 10) : "永久";
    const used = (l.usedAt || "").slice(0, 16) || "—";
    console.log(`${st.padEnd(6)} ${l.code.padEnd(21)} ${exp.padEnd(16)} ${used.padEnd(16)} ${l.note}`);
  }
  return list;
}

function revoke(code) {
  const list = load();
  const lic = list.find((l) => l.code === code.trim().toUpperCase());
  if (!lic) { console.log(`未找到激活码 ${code}`); return false; }
  lic.status = "revoked";
  save(list);
  console.log(`已吊销 ${lic.code}（${lic.note}）`);
  return true;
}

function revokeExpired() {
  const list = load();
  const now = Date.now();
  let n = 0;
  for (const l of list) {
    if (l.status === "active" && l.expiresAt && new Date(l.expiresAt).getTime() < now) {
      l.status = "revoked";
      n++;
    }
  }
  save(list);
  console.log(`已吊销 ${n} 个过期激活码`);
}

const [,, ...args] = process.argv;
const first = (args[0] || "").toLowerCase();

if (first === "--list" || first === "-l") {
  listAll();
} else if (first === "--revoke" || first === "-r") {
  if (!args[1]) { console.log("用法：node scripts/gen-license.mjs --revoke CODE"); process.exit(1); }
  revoke(args[1]);
} else if (first === "--revoke-expired") {
  revokeExpired();
} else if (!args[0]) {
  console.log(`用法：
  node scripts/gen-license.mjs [客户名] [天数]    生成激活码（无天数=永久）
  node scripts/gen-license.mjs --list            列出全部激活码
  node scripts/gen-license.mjs --revoke CODE     吊销激活码
  node scripts/gen-license.mjs --revoke-expired  吊销所有已过期的`);
  process.exit(0);
} else {
  const note = args[0];
  const days = args[1] ? Number(args[1]) : undefined;
  if (days !== undefined && (!Number.isInteger(days) || days <= 0)) {
    console.log("天数必须是正整数，如 30");
    process.exit(1);
  }
  const lic = makeCode(note, days);
  console.log(`✓ 已生成激活码（${lic.expiresAt ? `到期 ${lic.expiresAt.slice(0, 10)}` : "永久有效"}）`);
  console.log(lic.code);
  console.log(`备注：${note}`);
}
