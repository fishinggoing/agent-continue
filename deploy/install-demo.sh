#!/bin/sh
set -eu

source_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
test "$(id -u)" = 0
command -v openssl >/dev/null

if ! id agent-continue >/dev/null 2>&1; then
    useradd --system --home-dir /var/lib/agent-continue --shell /usr/sbin/nologin agent-continue
fi
install -d -m 0755 /opt/agent-continue
install -d -m 0700 -o agent-continue -g agent-continue /var/lib/agent-continue
install -d -m 0755 /var/lib/agent-continue-acme
if test -f /opt/agent-continue/agent-continue; then
    cp -p /opt/agent-continue/agent-continue /opt/agent-continue/agent-continue.previous
fi
install -m 0755 "$source_dir/agent-continue-linux-amd64" /opt/agent-continue/agent-continue.next
mv /opt/agent-continue/agent-continue.next /opt/agent-continue/agent-continue
if ! test -f /etc/agent-continue.env; then
    umask 077
    printf 'AGENT_CONTINUE_TOKEN=%s\nTZ=Asia/Shanghai\n' "$(openssl rand -hex 32)" > /etc/agent-continue.env
fi
chmod 0600 /etc/agent-continue.env
install -m 0644 "$source_dir/agent-continue.service" /etc/systemd/system/agent-continue.service
systemctl daemon-reload
systemctl enable agent-continue
systemctl restart agent-continue
sleep 1
systemctl is-active agent-continue
curl --fail --silent http://127.0.0.1:8080/healthz
printf '\n'
sha256sum /opt/agent-continue/agent-continue
