#!/bin/sh
set -eu
source_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
existing_site=${1:?Pass the existing HTTP default site config}
test "$(id -u)" = 0
install -m 0644 "$source_dir/nginx-demo-location.conf" /etc/nginx/agent-continue-demo-location.conf
if ! grep -q 'include /etc/nginx/agent-continue-demo-location.conf;' "$existing_site"; then
    test "$(grep -c 'server_name _;' "$existing_site")" = 1
    cp -p "$existing_site" "$source_dir/http-site-before-demo.conf"
    sed '/server_name _;/a\    include /etc/nginx/agent-continue-demo-location.conf;' "$existing_site" > "$source_dir/http-site-with-demo.conf"
    cp "$source_dir/http-site-with-demo.conf" "$existing_site"
fi
nginx -t
systemctl reload nginx
curl --fail --silent http://127.0.0.1:8080/healthz
printf '\n'
