/**
 * 数据层工作区（workspace）预留 —— 多租户分区的落点
 *
 * 现状：全站单一数据空间，所有客户运营数据在 data/xxx.json（DEFAULT_WORKSPACE）。
 * 未来：备案 + 国内服务器后做「一码一工作区」，客户数据按 data/{workspace}/xxx.json 隔离。
 *
 * 分区改造点（预期半天）：
 *   1. 各数据模块的 file 常量从 dataPath(DEFAULT_WORKSPACE, ...) 换成按 session 的 workspace 解析；
 *   2. server 路由层把 session.workspace 传给各模块（或 module-level workspace 上下文）。
 *
 * 隔离边界：
 *   - 客户运营数据（走 dataPath）：entities / publish / kb / anchor / articles / cites
 *   - 系统级全局共享（不走 dataPath）：bots.json（爬虫表）、licenses.json、sessions.json、
 *     checks.jsonl、audits.jsonl（检测/审计是公网功能）、softwen 资源表 / token
 */
import path from "node:path";

/** 默认工作区：映射到 data/xxx.json（不产生子目录，保持现有路径与数据零迁移） */
export const DEFAULT_WORKSPACE = "default";

/**
 * 解析某个数据文件在指定工作区下的绝对路径。
 * default 工作区直接落到 data/ 根（兼容现状）；非 default 落到 data/{workspace}/ 子目录。
 */
export function dataPath(workspace: string, file: string): string {
  if (workspace === DEFAULT_WORKSPACE) {
    return path.resolve(process.cwd(), "data", file);
  }
  return path.resolve(process.cwd(), "data", workspace, file);
}
