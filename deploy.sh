#!/usr/bin/env bash
# =====================================================================
# GEOloopOS Identity Engine · AI 可见度基础设施 — 一键私有化部署
# 自动检测环境：有 Docker 用 Docker，否则用 Node 直跑。
# 用法： bash deploy.sh
# =====================================================================
set -e
cd "$(dirname "$0")"

echo "=================================================="
echo " GEOloopOS Identity Engine · 一键私有化部署"
echo "=================================================="

# ---------- 1. 配置 AI 模型 Key ----------
if [ ! -f .env ]; then
  echo ""
  echo "[1/3] 配置 AI 模型 API Key（检测时调用，数据不出你的服务器）"
  read -rp "  DeepSeek API Key（必填，platform.deepseek.com 获取）: " DEEPSEEK
  read -rp "  豆包/方舟 API Key（可选，console.volcengine.com/ark 获取）: " ARK
  if [ -n "$DEEPSEEK" ]; then echo "DEEPSEEK_API_KEY=$DEEPSEEK" >> .env; fi
  if [ -n "$ARK" ]; then echo "ARK_API_KEY=$ARK" >> .env; fi
  if [ ! -s .env ]; then echo "  错误：至少需要一个 API Key"; exit 1; fi
  chmod 600 .env
  echo "  已写入 .env（权限 600）"
else
  echo "[1/3] 检测到已有 .env，跳过配置"
fi

# ---------- 2. 检测运行环境 ----------
echo "[2/3] 检测运行环境..."
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  MODE="docker"
  echo "  ✓ 检测到 Docker → 使用容器部署（推荐，可随系统自启）"
else
  MODE="node"
  echo "  ✗ 未检测到 Docker → 使用 Node 直跑（需 Node.js 18+）"
fi

# ---------- 3. 启动 ----------
echo "[3/3] 启动服务..."
if [ "$MODE" = "docker" ]; then
  docker compose up -d --build
  sleep 3
  PORT=$(grep -E '^PORT=' .env | head -1 | cut -d= -f2)
  PORT=${PORT:-8788}
  echo "  ✓ 容器已启动，健康检查通过后即可访问"
  echo "  ✓ http://localhost:${PORT}   （局域网/服务器 IP:${PORT}）"
else
  command -v node >/dev/null 2>&1 || { echo "  错误：需要 Node.js 18+，请先安装 https://nodejs.org"; exit 1; }
  npm install --no-audit --no-fund
  if pgrep -f "tsx src/server.ts" >/dev/null 2>&1; then
    echo "  ✓ 服务已在运行"
  else
    nohup npx tsx src/server.ts > /tmp/geoloopos.log 2>&1 &
    sleep 3
    echo "  ✓ 已启动，日志: /tmp/geoloopos.log"
  fi
  echo "  ✓ http://localhost:8788"
fi

echo ""
echo "=================================================="
echo " 完成。数据保存在 ./data/（检测历史/锚点/引用追踪）"
echo " 停止:   docker compose down   （Node 模式: pkill -f 'tsx src/server.ts'）"
echo " 查看日志: docker compose logs -f （Node 模式: tail -f /tmp/geoloopos.log）"
echo "=================================================="
