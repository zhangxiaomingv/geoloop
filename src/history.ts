/**
 * 检测历史 — 持久化到 data/checks.jsonl（每行一份完整报告）
 * 追加写 + 反向读最近 N 条，零依赖、无需数据库。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { CheckReport } from "./check.js";

const file = path.resolve(process.cwd(), "data/checks.jsonl");

export function appendCheck(report: CheckReport): void {
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify(report) + "\n", "utf-8");
}

/** 读取最近 limit 条历史（新的在前） */
export function listChecks(limit = 30): CheckReport[] {
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, "utf-8").split("\n").filter(Boolean);
  const reports: CheckReport[] = [];
  for (let i = lines.length - 1; i >= 0 && reports.length < limit; i--) {
    try {
      reports.push(JSON.parse(lines[i]) as CheckReport);
    } catch {
      /* 跳过损坏行 */
    }
  }
  return reports;
}
