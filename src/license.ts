/**
 * 激活码 + session 门禁（方案 A：授权码模式，绕过商户号）
 *
 * - 激活码台账：data/licenses.json（code / status / expiresAt / note / createdAt / usedAt）
 * - session：data/sessions.json（token / code / createdAt / expiresAt），token 为随机 48 hex
 * - 生成激活码需要 ADMIN_KEY（env LICENSE_ADMIN_KEY），校验无需外部服务
 *
 * 公网安全说明：激活码一旦生成即永久有效（除非手动 revoke），只做「付费授权」门禁，
 * 不做限流/防爆破——防爆破由登录端自身（激活码随机性 + 可 revoke）承担。
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import path from "node:path";

const here = process.cwd();
const LICENSE_FILE = path.join(here, "data", "licenses.json");
const SESSION_FILE = path.join(here, "data", "sessions.json");

export interface License {
  code: string;
  status: "active" | "revoked";
  expiresAt: string | null; // ISO；null = 永久
  note: string;
  createdAt: string;
  usedAt: string | null;
}

export interface Session {
  token: string;
  code: string;
  createdAt: string;
  expiresAt: string; // ISO
}

function readJson<T>(file: string, fallback: T): T {
  if (!existsSync(file)) return fallback;
  try { return JSON.parse(readFileSync(file, "utf-8")) as T; }
  catch { return fallback; }
}

function writeJson(file: string, data: unknown): void {
  writeFileSync(file, JSON.stringify(data, null, 2));
}

export function loadLicenses(): License[] {
  return readJson<License[]>(LICENSE_FILE, []);
}
function saveLicenses(list: License[]): void {
  writeJson(LICENSE_FILE, list);
}

export function loadSessions(): Session[] {
  return readJson<Session[]>(SESSION_FILE, []);
}
function saveSessions(list: Session[]): void {
  writeJson(SESSION_FILE, list);
}

/** 生成一个激活码（大写，去易混字符），返回未落盘的对象 */
export function generateCode(note = ""): License {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 去掉 I O 0 1
  const seg = () => Array.from({ length: 4 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
  const code = `GEO-${seg()}-${seg()}-${seg()}`;
  return {
    code,
    status: "active",
    expiresAt: null,
    note,
    createdAt: new Date().toISOString(),
    usedAt: null,
  };
}

/** 新增一枚激活码并落盘（ADMIN_KEY 校验在路由层） */
export function issueLicense(opts: { note?: string; days?: number } = {}): License {
  const lic = generateCode(opts.note);
  if (opts.days && opts.days > 0) {
    lic.expiresAt = new Date(Date.now() + opts.days * 86400_000).toISOString();
  }
  const list = loadLicenses();
  list.push(lic);
  saveLicenses(list);
  return lic;
}

/** 校验激活码：存在 + active + 未过期。通过返回 License，失败返回 null */
export function verifyLicense(code: string): License | null {
  const lic = loadLicenses().find((l) => l.code === code.trim().toUpperCase());
  if (!lic || lic.status !== "active") return null;
  if (lic.expiresAt && new Date(lic.expiresAt).getTime() < Date.now()) return null;
  return lic;
}

/** 列出激活码（管理用，脱敏不用——管理端本身就掌握全部） */
export function listLicenses(): License[] {
  return loadLicenses().reverse(); // 新的在前
}

/** 吊销激活码 */
export function revokeLicense(code: string): boolean {
  const list = loadLicenses();
  const lic = list.find((l) => l.code === code.trim().toUpperCase());
  if (!lic) return false;
  lic.status = "revoked";
  saveLicenses(list);
  return true;
}

/** 校验激活码成功时标记 usedAt */
export function markUsed(code: string): void {
  const list = loadLicenses();
  const lic = list.find((l) => l.code === code.trim().toUpperCase());
  if (lic && !lic.usedAt) {
    lic.usedAt = new Date().toISOString();
    saveLicenses(list);
  }
}

/** 签发 session，落盘并返回 token */
export function createSession(code: string, ttlMs = 30 * 86400_000): Session {
  const sess: Session = {
    token: randomBytes(24).toString("hex"),
    code,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + ttlMs).toISOString(),
  };
  const list = loadSessions();
  // 同 code 旧 session 全部失效（一码一 session，换设备重新登录）
  const keep = list.filter((s) => s.code !== code);
  keep.push(sess);
  saveSessions(keep);
  return sess;
}

/** 校验 session token，有效返回 Session，否则 null */
export function verifySession(token: string): Session | null {
  const sess = loadSessions().find((s) => s.token === token);
  if (!sess) return null;
  if (new Date(sess.expiresAt).getTime() < Date.now()) {
    // 惰性清理过期 session
    saveSessions(loadSessions().filter((s) => s.token !== token));
    return null;
  }
  return sess;
}

/** 注销 session */
export function destroySession(token: string): void {
  saveSessions(loadSessions().filter((s) => s.token !== token));
}

/** 从 Cookie 头取某 cookie 值 */
export function parseCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    if (k === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return null;
}

/** 常量时间比较（防时序攻击，虽激活码随机性已够） */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}
