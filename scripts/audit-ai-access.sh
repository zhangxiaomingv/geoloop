#!/usr/bin/env bash
# AI 爬虫放行状态审计 —— GEOloopOS 客户站审计工具
#
# 方法源自 zkoner.com 首次实测（2026-08-25）。审计三层：
#   L1 robots.txt   —— 礼貌层：AI 爬虫是否被声明放行
#   L2 边缘拦截实测 —— 强制层：用真实 AI 爬虫 UA 访问首页，看是否被 CDN/WAF 拦
#   L3 可发现性     —— sitemap.xml 与 llms.txt 是否在线
#
# UA 矩阵唯一事实源：data/bots.json（观测中间件与审计脚本共用一张表）
#
# 用法: bash scripts/audit-ai-access.sh <domain> [深度页路径]
# 例:   bash scripts/audit-ai-access.sh zkoner.com /geo
set -u

DOMAIN="${1:?用法: audit-ai-access.sh <domain> [/deep/path]}"
DEEP="${2:-}"
BASE="https://$DOMAIN"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BOTS_JSON="$ROOT/data/bots.json"

if [ ! -f "$BOTS_JSON" ]; then
  echo "❌ 找不到 $BOTS_JSON（请在 geoloopos 仓库内运行）"; exit 1
fi

echo "════════════════════════════════════════════════"
echo " AI 爬虫放行审计 · $DOMAIN · $(date +%F)"
echo "════════════════════════════════════════════════"

# ---- L3 可发现性 ----
echo "── L3 可发现性 ──"
for p in robots.txt sitemap.xml llms.txt; do
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 20 "$BASE/$p" || echo 000)
  printf '  %-12s HTTP %s\n' "/$p" "$code"
done

# ---- L1 robots.txt 放行声明 ----
echo "── L1 robots.txt ──"
ROBOTS=$(curl -s --max-time 20 "$BASE/robots.txt")
if echo "$ROBOTS" | grep -qi 'user-agent'; then
  star_disallow=$(echo "$ROBOTS" | awk '/^User-agent:[[:space:]]*\*/{f=1} f&&/^Disallow:/{print; exit}')
  if [ -z "$star_disallow" ] || echo "$star_disallow" | grep -q 'Disallow:[[:space:]]*$'; then
    echo "  通配规则 * ：全站允许（无 Disallow 生效行）"
  else
    echo "  ⚠️ 通配规则存在限制: $star_disallow"
  fi
  ai_ua=$(echo "$ROBOTS" | grep -icE '^User-agent:[[:space:]]*(gptbot|claudebot|perplexitybot|bytespider|baiduspider|google-extended|ccbot)')
  echo "  显式声明的 AI 爬虫组：${ai_ua} 个"
else
  echo "  （robots.txt 为空或不存在 → 默认全放行）"
fi

# ---- L2 边缘拦截实测 ----
# UA 矩阵 = data/bots.json 全量 probe（node 零依赖读取），人类基准置顶
echo "── L2 边缘拦截实测（首页 + ${DEEP:-跳过}）──"
blocked=0
total=0
test_ua() { # $1=ua $2=label
  total=$((total+1))
  local hdr code mit flag
  hdr=$(curl -s -D - -o /dev/null --max-time 20 -A "$1" "$BASE/")
  code=$(echo "$hdr" | head -1 | awk '{print $2}')
  mit=$(echo "$hdr" | grep -i '^cf-mitigation' | tr -d '\r')
  flag="✅"; if [ "$code" != "200" ]; then flag="🚫"; blocked=$((blocked+1)); fi
  printf '  %s %-24s %s %s\n' "$flag" "$2" "$code" "$mit"
}

test_ua "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" "人类浏览器(基准)"

while IFS=$'\t' read -r ua label; do
  [ -n "$ua" ] && test_ua "$ua" "$label"
done < <(node -e '
  const bots = require(process.argv[1]);
  for (const b of bots) console.log(`${b.probe}\t${b.vendor} · ${b.engine}`);
' "$BOTS_JSON")

# 深度页抽查：GPTBot 与 Bytespider 两个代表
if [ -n "$DEEP" ]; then
  while IFS=$'\t' read -r ua label; do
    code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 20 -A "$ua" "$BASE$DEEP")
    printf '  深度页 %s · %s → %s\n' "$DEEP" "$label" "$code"
  done < <(node -e '
    const bots = require(process.argv[1]);
    for (const id of ["gptbot", "bytespider"]) {
      const b = bots.find(x => x.id === id);
      if (b) console.log(`${b.probe}\t${b.vendor}`);
    }
  ' "$BOTS_JSON")
fi

# ---- 结论 ----
echo "────────────────────────────────────────────────"
if [ "$blocked" -eq 0 ]; then
  echo " 结论：AI 爬虫放行状态 ✅ 全部通过（$total/$total UA 均 200）"
else
  echo " 结论：🚫 $blocked/$total 个爬虫被拦截 —— 需检查 Cloudflare「拦截 AI 爬虫」开关与 WAF 规则"
fi
echo "════════════════════════════════════════════════"
