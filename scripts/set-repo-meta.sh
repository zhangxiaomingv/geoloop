#!/usr/bin/env bash
# set-repo-meta.sh — 一次性补全 GitHub 仓库元数据（description / homepage / topics）
#
# 这些是 GitHub 搜索与 AI 爬虫最先读到的仓库「首屏」，现在全为空。
# 需要一个有 repo 权限的 PAT（不再用旧的失效 token）：
#   1. 打开 https://github.com/settings/tokens → Generate new token (classic)
#   2. 勾选 repo 范围，复制 ghp_...
#   3. 运行本脚本（token 只传给本命令，不留存）
#
#   GITHUB_TOKEN=ghp_xxx bash scripts/set-repo-meta.sh        # 设置
#   GITHUB_TOKEN=ghp_xxx bash scripts/set-repo-meta.sh --verify  # 只查看当前值
#
# 或者：仓库页面 Settings → General 填 Description/Website，仓库首页点 Topics。

set -euo pipefail
REPO="zhangxiaomingv/geoloop"
TOKEN="${GITHUB_TOKEN:-}"

DESC='GEOloop · AI 可见度基础设施 — 开源 AI 身份引擎。让 AI 认识你、理解你、推荐你。Measure & grow how AI search engines (DeepSeek, Doubao) recognize, describe & recommend a brand, person or website.'
HOMEURL='https://zkoner.com'
TOPICS=(
  geo
  generative-engine-optimization
  ai-search
  ai-search-optimization
  visibility
  brand-monitoring
  llm
  seo
  open-source
  identity-engine
  brand-intelligence
  analytics
)

[ -z "$TOKEN" ] && { echo "缺少 GITHUB_TOKEN（需 repo 权限）。创建：https://github.com/settings/tokens"; exit 1; }

jget() { node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const r=JSON.parse(d);$1})"; }

if [ "${1:-}" = "--verify" ]; then
  curl -sS "https://api.github.com/repos/$REPO" | jget 'console.log("description:", JSON.stringify(r.description));console.log("homepage:", JSON.stringify(r.homepage));console.log("topics:", JSON.stringify(r.topics));console.log("license:", r.license&&r.license.spdx_id)'
  exit 0
fi

echo "==> 设置 description + homepage"
curl -sS -X PATCH "https://api.github.com/repos/$REPO" \
  -H "Authorization: token $TOKEN" -H "Accept: application/vnd.github+json" \
  -d "$(node -e 'const d=process.argv[1],h=process.argv[2];process.stdout.write(JSON.stringify({description:d,homepage:h}))' "$DESC" "$HOMEURL")" \
  | jget 'if(r.message){console.log("失败:",r.message)}else{console.log("✓ description:",r.description);console.log("✓ homepage:",r.homepage)}'

echo "==> 设置 topics"
curl -sS -X PUT "https://api.github.com/repos/$REPO/topics" \
  -H "Authorization: token $TOKEN" -H "Accept: application/vnd.github+json" \
  -d "$(node -e 'const t=process.argv.slice(1);process.stdout.write(JSON.stringify({names:t}))' "${TOPICS[@]}")" \
  | jget 'if(r.names){console.log("✓ topics ("+r.names.length+"):",r.names.join(", "))}else{console.log("topics 失败:",JSON.stringify(r))}'

echo "==> 完成。浏览器可刷新 https://github.com/$REPO 看效果。"
