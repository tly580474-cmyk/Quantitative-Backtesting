#!/usr/bin/env bash
set -euo pipefail
# Run after extracting sources into /opt/quant-backtest. Existing data/config are preserved.
[[ $EUID -eq 0 ]] || { echo 'Run as root'; exit 1; }
ROOT=/opt/quant-backtest
cd "$ROOT"
id quant >/dev/null 2>&1 || useradd --system --create-home --home-dir /var/lib/quant-backtest --shell /bin/bash quant
install -d -o quant -g quant server/data server/.logs server/tmp_output /var/lib/quant-backtest
install -m 0755 deploy/linux/quant-public-control /usr/local/sbin/quant-public-control
printf '%s\n' 'quant ALL=(root) NOPASSWD: /usr/local/sbin/quant-public-control status, /usr/local/sbin/quant-public-control enable, /usr/local/sbin/quant-public-control disable' > /etc/sudoers.d/quant-public
chmod 0440 /etc/sudoers.d/quant-public
visudo -cf /etc/sudoers.d/quant-public
cat > /etc/systemd/system/quant-backend.service <<'EOF'
[Unit]
Description=Quant backtest API
After=network-online.target mysql.service
Wants=network-online.target
[Service]
Type=simple
User=quant
Group=quant
WorkingDirectory=/opt/quant-backtest/server
Environment=NODE_ENV=production TZ=Asia/Shanghai PYTHONUTF8=1 QUANT_BACKEND_SUPERVISED=true
Environment=PATH=/opt/quant-backtest/.venv/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/bin/node --import tsx src/app.ts
Restart=on-failure
RestartSec=3
TimeoutStopSec=30
KillMode=control-group
UMask=0077
[Install]
WantedBy=multi-user.target
EOF
cat > /etc/systemd/system/quant-job@.service <<'EOF'
[Unit]
Description=Quant scheduled %i update
After=mysql.service network-online.target
[Service]
Type=oneshot
User=quant
Group=quant
WorkingDirectory=/opt/quant-backtest/server
Environment=TZ=Asia/Shanghai PYTHONUTF8=1
Environment=PATH=/opt/quant-backtest/.venv/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/bin/node scripts/linuxJob.mjs %i
TimeoutStartSec=6h
KillMode=control-group
UMask=0077
EOF
cat > /etc/systemd/system/quant-job@.timer <<'EOF'
[Unit]
Description=Check Quant %i schedule from .env every minute
[Timer]
OnCalendar=*-*-* *:*:00
AccuracySec=1s
Unit=quant-job@%i.service
[Install]
WantedBy=timers.target
EOF
# Separate nginx master for public UI; management remains reachable when it is stopped.
cat > /etc/systemd/system/quant-public.service <<'EOF'
[Unit]
Description=Quant public UI gateway
After=network.target quant-backend.service
[Service]
Type=simple
ExecStart=/usr/sbin/nginx -c /etc/nginx/quant-public.conf -g "daemon off;"
ExecReload=/bin/kill -HUP $MAINPID
KillSignal=SIGQUIT
Restart=on-failure
[Install]
WantedBy=multi-user.target
EOF
install -m 0644 deploy/linux/nginx-public.conf /etc/nginx/quant-public.conf
install -m 0644 deploy/linux/nginx-admin.conf /etc/nginx/conf.d/quant-admin.conf
install -m 0644 deploy/linux/nginx-proxy.conf /etc/nginx/quant-proxy.conf
nginx -t
nginx -t -c /etc/nginx/quant-public.conf
chown -R quant:quant "$ROOT"
systemctl daemon-reload
systemctl enable --now quant-backend.service
if python3 - <<'PY'
import json, pathlib, sys
p = pathlib.Path('/opt/quant-backtest/server/data/admin/public-access.json')
if not p.exists(): sys.exit(0)
try: enabled = json.loads(p.read_text()).get('enabled') is True
except (ValueError, OSError): enabled = False
sys.exit(0 if enabled else 1)
PY
then systemctl enable --now quant-public.service
else systemctl disable --now quant-public.service
fi
for job in research minute fund-flow tdx-shadow; do systemctl enable --now "quant-job@$job.timer"; done
systemctl reload nginx
echo 'Installed. UI :8080, admin :8081. Gateway Basic auth file: /etc/nginx/quant.htpasswd'
