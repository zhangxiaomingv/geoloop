#!/usr/bin/env bash
# geoloopos 状态一览 —— 一条命令看清所有「版本面」，防止「版本回滚了？」误判
# （2026-08-25 乌龙复盘：本地工作区/GitHub/线上站/本地容器 四个面版本不一致，无入口可查）
# 用法：bash scripts/status.sh
cd "$HOME/geoloopos" || exit 1

line() { printf '%s\n' "──────────────────────────────────────────────"; }

line; echo "【容器】"; docker ps -a --filter name=geoloopos --filter name=cloudflared --format '  {{.Names}}\t{{.Status}}'

echo; echo "【代码版本】"
local_head=$(git rev-parse --short HEAD 2>/dev/null)
dirty=$(git status --porcelain 2>/dev/null | wc -l)
echo "  本地 HEAD        : ${local_head}（未提交改动 ${dirty} 个文件）"
remote_head=$(git ls-remote origin main 2>/dev/null | cut -c1-7)
[ "$local_head" = "$remote_head" ] && sync="✓ 与本地一致" || sync="⚠ 落后/分叉于本地"
echo "  GitHub main      : ${remote_head:-查询失败}（${sync}）"

echo; echo "【服务健康】"
curl -sf -m 5 -o /dev/null http://localhost:8788 \
  && echo "  本地产品 localhost:8788       : ✓ 在线" || echo "  本地产品 localhost:8788       : ✗ 不可达"
t=$(curl -sf -m 12 https://geoloopos.com/ 2>/dev/null | grep -o '<title>[^<]*' | head -1)
[ -z "$t" ] && t=$(curl -sf -m 12 https://geoloopos.com/ 2>/dev/null | grep -o '<title>[^<]*' | head -1)  # 隧道偶发抖动重试一次
case "$t" in
  *"增长闭环"*) echo "  公网产品 geoloopos.com         : ✓ 容器产品页已接管" ;;
  *) echo "  公网产品 geoloopos.com         : ⚠ 仍为 Pages 内容（DNS 未切到隧道）" ;;
esac
observe_ok=$(curl -sf -m 12 https://geoloopos.com/observe/ 2>/dev/null | grep -c 'AI 爬虫来访监测')
echo "  来访监测 geoloopos.com/observe : $([ "$observe_ok" -ge 1 ] && echo '✓ 可达' || echo '✗ 不可达')"

line; echo "判读：geoloopos.com = 容器产品（隧道 geoloopos.com → 容器 8788），"
echo "     含检测/observe/llms/robots/sitemap。Cloudflare Pages 项目 geoloopos-com 已停用。"
echo "     observe 数据在容器 data/observations/events.jsonl（cron 每小时重生成 /observe 页）。"; line
