/**
 * 自动复测 — 认知曲线的数据积累引擎（护城河第一步）
 *
 * 把 data/entities.json 里「已建档且有检测记录」的品牌/站点周期性重测一遍，
 * 每次 attachCheck 追加一个新快照 → 认知随时间的变化曲线自动积累，
 * 供成绩单、lab 数据、行业基准引用。
 *
 * 用法：npm run retest            # 真实复测全部建档实体
 *       npm run retest -- --dry   # 只列目标与当前分数，不调用 API
 * 定时：scripts/install-retest-cron.sh 装宿主 crontab（每周日 03:30 自动跑）。
 *
 * 安全设计：
 *  - flock 锁在 install 脚本层防重入；本脚本再带 PID 锁兜底（防同一脚本双开）
 *  - 跳过 classify 判定为问句的档案（自愈早期数据污染，如误入档案的场景问句）
 *  - 单个实体复测失败不中断整体，错误计入摘要与日志
 *  - 每次批量结果落盘 data/retest-log.jsonl，供成绩单/复盘回溯
 */

import "dotenv/config";
import { appendFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { loadEntities, attachCheck } from "./entity.js";
import { classify, runCheck } from "./check.js";

const dry = process.argv.includes("--dry");
// PID 锁文件。注意与 cron 外层的 flock 锁分开：
//  flock 锁 = /tmp/geoloopos-retest.flock（常驻，绝不可被本脚本 unlink）
//  PID  锁 = /tmp/geoloopos-retest.pid  （每次运行写入/清理）
const LOCK = "/tmp/geoloopos-retest.pid";
const LOG = "data/retest-log.jsonl";

interface BatchItem {
  name: string;
  prev: number;
  next: number;
  delta: number;
  verdict: string;
  error?: string;
}

function cleanup(): void {
  if (!dry) {
    try { unlinkSync(LOCK); } catch { /* 锁可能已被清理 */ }
  }
}

// PID 锁兜底：进程存活则说明并发，直接退出；否则清陈旧锁
if (!dry) {
  if (existsSync(LOCK)) {
    let alive = false;
    try { process.kill(Number(readFileSync(LOCK, "utf-8")), 0); alive = true; } catch { /* 陈旧锁 */ }
    if (alive) {
      console.error(`[复测] 已有进程在运行（PID ${readFileSync(LOCK, "utf-8").trim()}），本次跳过`);
      process.exit(0);
    }
    unlinkSync(LOCK);
  }
  writeFileSync(LOCK, String(process.pid));
}

try {
  await main();
} catch (e) {
  console.error("[复测] 运行失败：", e);
  cleanup();
  process.exit(1);
}

async function main(): Promise<void> {
  const targets = loadEntities().filter((e) => {
    if (e.checks.length === 0) return false; // 只有问句类/从未检测的档案不参与
    const t = classify(e.name).type; // 自愈：误入档案的问句（如场景问句）不重测
    return t === "brand" || t === "site";
  });

  if (!targets.length) {
    console.log("[复测] 没有可复测的实体档案（需要已有检测记录的品牌/站点）。");
    process.exit(0);
  }

  console.log(`[复测] ${dry ? "[dry] " : ""}待复测 ${targets.length} 个实体`);
  const rows: BatchItem[] = [];

  for (const e of targets) {
    const prev = e.checks[e.checks.length - 1].score;
    const prevVerdict = e.checks[e.checks.length - 1].verdict;

    if (dry) {
      rows.push({ name: e.name, prev, next: prev, delta: 0, verdict: prevVerdict });
      console.log(`  ${e.name}: 当前 ${prev}（${prevVerdict}）`);
      continue;
    }

    try {
      const report = await runCheck(e.name);
      attachCheck(report); // 追加快照（品牌/站点进档案；问句已被上面过滤）
      const delta = report.score - prev;
      rows.push({ name: e.name, prev, next: report.score, delta, verdict: report.verdict });
      console.log(`  ${e.name}: ${prev} → ${report.score} (${delta > 0 ? "+" : ""}${delta}) ${report.verdict}`);
    } catch (err) {
      rows.push({ name: e.name, prev, next: prev, delta: 0, verdict: prevVerdict, error: (err as Error).message });
      console.error(`  ${e.name}: 复测失败 — ${(err as Error).message}`);
    }
  }

  const ok = rows.filter((r) => !r.error);
  const up = ok.filter((r) => r.delta > 0).length;
  const down = ok.filter((r) => r.delta < 0).length;
  const flat = ok.length - up - down;
  console.log(`\n[复测] 完成：${ok.length} 成功 / ${rows.length - ok.length} 失败 · ↑${up} ↓${down} 持平${flat}`);

  if (!dry) {
    // 落盘批量日志（成绩单/复盘用），append 追加
    appendFileSync(
      LOG,
      JSON.stringify({ at: new Date().toISOString(), count: rows.length, up, down, flat, failed: rows.length - ok.length, items: rows }) + "\n",
      "utf-8"
    );
    console.log(`[复测] 日志已追加 ${LOG}`);
  }

  process.exit(ok.length ? 0 : 1);
}
