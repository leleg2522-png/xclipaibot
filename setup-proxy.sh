#!/bin/bash

PROXY_USER="botproxy"
PROXY_PASS="Xclip2026Proxy!"
PROXY_PORT=3128

apt-get update -y
apt-get install -y squid apache2-utils

htpasswd -bc /etc/squid/passwd "$PROXY_USER" "$PROXY_PASS"

cat > /etc/squid/squid.conf << EOF
http_port $PROXY_PORT

auth_param basic program /usr/lib/squid/basic_ncsa_auth /etc/squid/passwd
auth_param basic realm Proxy
auth_param basic credentialsttl 2 hours

acl authenticated proxy_auth REQUIRED
http_access allow authenticated

http_access deny all

via off
forwarded_for delete
request_header_access X-Forwarded-For deny all
EOF

systemctl restart squid
systemctl enable squid

echo "Squid proxy berhasil dipasang!"
echo "Host     : $(curl -s ifconfig.me)"
echo "Port     : $PROXY_PORT"
echo "Username : $PROXY_USER"
echo "Password : $PROXY_PASS"
