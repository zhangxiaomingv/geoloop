#!/usr/bin/env bash
# GEOloopOS 私有部署 · 升级（数据卷保留，代码随镜像更新）
set -euo pipefail

echo ">>> 1/3 备份当前数据..."
./backup.sh ./backup || echo "  备份跳过（可手动备份）"

echo ">>> 2/3 拉取最新镜像..."
docker compose pull geoloopos

echo ">>> 3/3 重建容器..."
docker compose up -d

echo "✓ 升级完成。健康检查：docker compose ps"
