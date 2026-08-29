#!/usr/bin/env bash
# GEOloopOS 私有部署 · 数据卷备份
# 用法：./backup.sh [输出目录]
set -euo pipefail

OUT="${1:-./backup}"
mkdir -p "$OUT"
STAMP="$(date +%F-%H%M)"
DEST="$OUT/geoloopos-data-$STAMP.tar.gz"

docker run --rm \
  -v geoloopos-data:/app/data \
  -v "$(pwd)":/backup \
  alpine tar czf "/backup/$(basename "$DEST")" -C /app/data .

echo "✓ 备份完成: $DEST"
echo "  恢复: tar xzf $DEST -C /app/data 后重启容器"
