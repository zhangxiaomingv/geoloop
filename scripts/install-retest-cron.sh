#!/usr/bin/env bash
# install-retest-cron.sh — 安装「认知曲线自动复测」宿主 crontab
#
# 每周日 03:30 把 data/entities.json 里已建档的品牌/站点实体自动复测一遍，
# 每次 attachCheck 追加认知曲线快照 + 批量日志 data/retest-log.jsonl
# —— 护城河数据（企业 AI 认知数据库）无需人工开始自动积累。
#
# 特性：
#   - flock 锁防重入（/tmp/geoloopos-retest.flock，常驻；与脚本内 PID 锁 .pid 分离）
#   - 绝对路径 node/npm（cron 环境 PATH 极简，nvm 装的必须全路径）
#   - 日志追加到 data/retest.log（gitignored）
#   - 幂等：重复安装只替换 geoloopos-retest 那一行，其它 cron 不动
#   - 自定义节奏：RETEST_SCHEDULE="0 6 * * 1" bash scripts/install-retest-cron.sh
#
# 查看：crontab -l | grep geoloopos
# 卸载：crontab -l | grep -v geoloopos-retest | crontab -
# 手动跑一次（会真实调用 DeepSeek/豆包）：npm run retest

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # 仓库根目录
NODE_BIN="$(command -v node)"                            # nvm 全路径
NODE_DIR="$(dirname "$NODE_BIN")"                        # 注入 cron PATH
FLOCK="$(command -v flock || echo /usr/bin/flock)"
SCHEDULE="${RETEST_SCHEDULE:-30 3 * * 0}"                # 默认每周日 03:30

[ -x "$NODE_BIN" ] || { echo "✗ 找不到 node：$NODE_BIN"; exit 1; }
[ -x "$FLOCK" ] || { echo "✗ 找不到 flock（需 util-linux）"; exit 1; }

# cron 环境 PATH 极简：把 nvm 的 bin 目录加进去，npm/tsx 才找得到
CRON_CMD="cd $HERE && PATH=$NODE_DIR:\$PATH $FLOCK -n /tmp/geoloopos-retest.flock npm run retest >> $HERE/data/retest.log 2>&1"
LINE="$SCHEDULE $CRON_CMD"

# 幂等安装：先去掉旧的 geoloopos-retest 行，再加新行
TMP="$(mktemp)"
{ ( crontab -l 2>/dev/null || true ) | grep -v 'geoloopos-retest' || true; } > "$TMP"
printf '%s\n' "$LINE" >> "$TMP"
crontab "$TMP"
rm -f "$TMP"

echo "✅ 已安装复测 cron（节奏：$SCHEDULE）"
echo "    $LINE"
echo ""
echo "⚠️  触发后会自动调用 DeepSeek/豆包 复测全部建档实体（每周几次调用，成本可忽略）。"
echo "   运行日志：data/retest.log · 批量快照：data/retest-log.jsonl"
echo ""
echo "当前 crontab 中的 geoloopos 行："
crontab -l | grep geoloopos || echo "（未找到 — 安装可能未生效）"
