#!/usr/bin/env bash
# geoloopos 隧道直连旁路 —— 让 cloudflared 容器(172.21.0.99)的流量
# 直接走路由器(main 路由表),完全不经过 mqiba 加速器的 TUN/fake-ip。
# mqiba 的 ip rules 在优先级 9000+,这条在 100,优先匹配。
#
# 需要 root 运行:  sudo bash scripts/tunnel-bypass.sh
set -u

RULE="from 172.21.0.99/32 lookup main pref 100"

echo "==> 1/3 添加直连 ip rule (pref 100) ..."
ip rule del $RULE 2>/dev/null || true
ip rule add $RULE
echo "    done: $(ip rule show pref 100 | head -1)"

echo "==> 2/3 创建开机自启 systemd 服务 ..."
cat > /etc/systemd/system/geoloopos-tunnel-bypass.service <<'EOF'
[Unit]
Description=GeoloopOS cloudflared direct-bypass ip rule (bypass mqiba TUN)
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/sh -c 'ip rule del from 172.21.0.99/32 lookup main pref 100 2>/dev/null || true; ip rule add from 172.21.0.99/32 lookup main pref 100'

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now geoloopos-tunnel-bypass.service
echo "    service: $(systemctl is-enabled geoloopos-tunnel-bypass)"

echo "==> 3/3 校验 ..."
ip rule show | grep "172.21.0.99" && echo "OK: 直连旁路已生效"
