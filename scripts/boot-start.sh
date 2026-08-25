#!/usr/bin/env bash
# geoloopos 开机自启：等 docker 就绪 → compose up → 隧道容器
# 背景：非正常关机后 Docker 的 unless-stopped 策略不会自动恢复容器（2026-08-25 乌龙事件根因），
#      故用 crontab @reboot 兜底强制拉起。日志落 data/autostart.log。
set -u
LOG="$HOME/geoloopos/data/autostart.log"
{
  echo "[$(date '+%F %T')] boot-start 开始，等待 docker 就绪（最多 120s）…"
  ready=0
  for i in $(seq 1 24); do
    if docker info >/dev/null 2>&1; then ready=1; break; fi
    sleep 5
  done
  if [ "$ready" != "1" ]; then
    echo "[$(date '+%F %T')] ✗ docker 120 秒内未就绪，放弃本次自启"
    exit 1
  fi
  cd "$HOME/geoloopos"
  docker compose up -d --wait
  echo "[$(date '+%F %T')] ✓ geoloopos 容器已启动"
  if docker start cloudflared-tunnel >/dev/null 2>&1; then
    echo "[$(date '+%F %T')] ✓ cloudflared-tunnel 已启动"
  else
    echo "[$(date '+%F %T')] ⚠ cloudflared-tunnel 启动失败（公网走 Cloudflare Pages 不受影响）"
  fi
} >> "$LOG" 2>&1
