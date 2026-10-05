#!/bin/sh
set -eu
source_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ip=${1:?Pass the public IPv4 address}
existing_site=${2:?Pass the existing HTTP default site config}
case "$ip" in *[!0-9.]*|'') echo 'Invalid IPv4 address' >&2; exit 1;; esac
test "$(id -u)" = 0
test -x /opt/agent-continue-certbot/bin/certbot
install -m 0644 "$source_dir/nginx-acme.conf" /etc/nginx/agent-continue-acme.conf
if ! grep -q 'include /etc/nginx/agent-continue-acme.conf;' "$existing_site"; then
    test "$(grep -c 'server_name _;' "$existing_site")" = 1
    cp -p "$existing_site" "$source_dir/http-site-before-acme.conf"
    sed '/server_name _;/a\    include /etc/nginx/agent-continue-acme.conf;' "$existing_site" > "$source_dir/http-site-with-acme.conf"
    cp "$source_dir/http-site-with-acme.conf" "$existing_site"
fi
nginx -t
systemctl reload nginx
/opt/agent-continue-certbot/bin/certbot certonly --webroot -w /var/lib/agent-continue-acme \
    --ip-address "$ip" --required-profile shortlived --cert-name agent-continue-ip \
    --non-interactive --agree-tos --register-unsafely-without-email
sed "s/AGENT_IP/$ip/g" "$source_dir/nginx-ip-tls.conf" > "$source_dir/nginx-ip.generated.conf"
install -m 0644 "$source_dir/nginx-ip.generated.conf" /etc/nginx/sites-available/agent-continue-ip
ln -sfn /etc/nginx/sites-available/agent-continue-ip /etc/nginx/sites-enabled/agent-continue-ip
nginx -t
ufw allow 443/tcp
systemctl reload nginx
install -m 0644 "$source_dir/agent-continue-cert-renew.service" /etc/systemd/system/agent-continue-cert-renew.service
install -m 0644 "$source_dir/agent-continue-cert-renew.timer" /etc/systemd/system/agent-continue-cert-renew.timer
systemctl daemon-reload
systemctl enable --now agent-continue-cert-renew.timer
curl --fail --silent --resolve "$ip:443:127.0.0.1" "https://$ip/ac/healthz"
printf '\n'
