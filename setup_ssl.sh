#!/usr/bin/env bash
# This should be run by root user when server is first created
# Run this only about 24-48 hours after creating public DNS record of host

SCRIPTNAME=$(readlink -f "$0")
SCRIPTDIR=$(dirname "$SCRIPTNAME")

if [ -n "$1" ]; then
    EMAIL_ADDRESS="$1"
else
    echo -n "Please enter email address: "
    read EMAIL_ADDRESS
fi

CERTDIR="$SCRIPTDIR/certs"
if [ ! -d "$CERTDIR" ]; then
    mkdir -p "$CERTDIR"
fi
BOTUSER=$(whoami)
DOMAIN=$(grep -v '^#' "${SCRIPTDIR}/.env" | grep '^DOMAIN=' | cut -d '=' -f2- | sed 's/^"//;s/"$//')
FULLHOST=$(hostname).$DOMAIN

sudo -s <<EOF
# Temporarily open up firewall
ufw allow 80
ufw allow 443


cleanup() {
    ufw delete allow 80
    ufw delete allow 443
}
trap cleanup EXIT INT QUIT TERM

certbot certonly \
    --standalone \
    --non-interactive \
    --email $EMAIL_ADDRESS \
    --agree-tos \
    -d ${FULLHOST}

if [[ \$? -ne 0 ]]; then
    exit
fi

cat <<EOF1 >/etc/letsencrypt/renewal-hooks/deploy/10-copy-certs.sh
#!/usr/bin/env bash
DOMAIN=${FULLHOST}
CERTDIR=${CERTDIR}

cp /etc/letsencrypt/live/\\\$DOMAIN/{fullchain,privkey}.pem "\\\$CERTDIR"
chown $BOTUSER:$BOTUSER "\\\$CERTDIR"/*.pem
chmod 600 "\\\$CERTDIR"/privkey.pem
chmod 644 "\\\$CERTDIR"/fullchain.pem

EOF1

cat <<EOF2 >/etc/letsencrypt/renewal-hooks/pre/open-port-80.sh
#!/usr/bin/env bash
ufw allow 80/tcp
EOF2

cat <<EOF3 >/etc/letsencrypt/renewal-hooks/post/close-port-80.sh
#!/usr/bin/env bash
ufw delete allow 80/tcp
EOF3

chmod +x /etc/letsencrypt/renewal-hooks/deploy/10-copy-certs.sh
chmod +x /etc/letsencrypt/renewal-hooks/pre/open-port-80.sh
chmod +x /etc/letsencrypt/renewal-hooks/post/close-port-80.sh
/etc/letsencrypt/renewal-hooks/deploy/10-copy-certs.sh

EOF
