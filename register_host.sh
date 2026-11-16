#!/usr/bin/env bash

# Script to register host in Cloudflare

SCRIPTNAME=$(readlink -f "$0")
SCRIPTDIR=$(dirname "$SCRIPTNAME")

DOMAIN=$(grep -v '^#' "${SCRIPTDIR}/.env" | grep '^DOMAIN=' | cut -d '=' -f2- | sed 's/^"//;s/"$//')
CFLARE_ACCT_ID=$(grep -v '^#' "${SCRIPTDIR}/.env" | grep '^CFLARE_ACCT_ID=' | cut -d '=' -f2- | sed 's/^"//;s/"$//')
CFLARE_API_TOKEN=$(grep -v '^#' "${SCRIPTDIR}/.env" | grep '^CFLARE_API_TOKEN=' | cut -d '=' -f2- | sed 's/^"//;s/"$//')
FULLHOST=$(hostname).$DOMAIN
IPADDR=$(ip route get 1.1.1.1 | awk '{print $7; exit}')

## Validate presence of fields
if [ -z "$DOMAIN" ]; then
    echo "DOMAIN not defined in .env file"
    exit 1
fi

if [ -z "$CFLARE_ACCT_ID" ]; then
    echo "CFLARE_ACCT_ID not defined in .env file"
    exit 1
fi
if [ -z "$CFLARE_API_TOKEN" ]; then
    echo "CFLARE_API_TOKEN not defined in .env file"
    exit 1
fi

# Validate the API Token
VAL_RESULT=$(curl -s -X GET "https://api.cloudflare.com/client/v4/accounts/${CFLARE_ACCT_ID}/tokens/verify" \
    -H "Authorization: Bearer ${CFLARE_API_TOKEN}")

if [ "$(echo "$VAL_RESULT" | jq '.success')" == false ]; then
    echo "$VAL_RESULT" | jq '.errors[0].message'
    exit 1
fi
echo "Valid Cloudflare API Token"

# Get the Zone ID of the DOMAIN
VAL_RESULT=$(curl -s -X GET "https://api.cloudflare.com/client/v4/zones?name=${DOMAIN}" \
    -H "Authorization: Bearer ${CFLARE_API_TOKEN}")

if ! echo "$VAL_RESULT" | jq -e '.result | length > 0' >/dev/null; then
    echo "${DOMAIN} not registered by this account in Cloudflare"
    exit 1
fi
ZONE_ID=$(echo "$VAL_RESULT" | jq '.result[0].id')
ZONE_ID="${ZONE_ID//\"/}"
echo "${DOMAIN} domain has already been registered in Cloudflare"

# Check if this host already registered in Cloudflare
VAL_RESULT=$(curl -s -X GET "https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/dns_records?name=${FULLHOST}&type=A" \
    -H "Authorization: Bearer ${CFLARE_API_TOKEN}" \
    -H "Content-Type: application/json")
RECORD_ID=$(echo "${VAL_RESULT}" | jq -r '.result[0].id // empty')
METHOD="patched"

if [ -n "${RECORD_ID}" ]; then
    # Patching existing record
    echo "${FULLHOST} already registered by this account in Cloudflare - updating DNS record"
    VAL_RESULT=$(curl -s -X PATCH "https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/dns_records/${RECORD_ID}" \
        -H "Authorization: Bearer ${CFLARE_API_TOKEN}" \
        -H "Content-Type: application/json" \
        --data "{
            \"content\": \"${IPADDR}\",
            \"ttl\": 1,
            \"proxied\": true
        }")
else
    # Add host to Cloudflare
    METHOD="added"
    echo "Adding ${FULLHOST} to Cloudflare"
    VAL_RESULT=$(curl -s -X POST "https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/dns_records" \
        -H "Authorization: Bearer ${CFLARE_API_TOKEN}" \
        -H "Content-Type: application/json" \
        --data "{
        \"type\": \"A\",
        \"name\": \"${FULLHOST}\",
        \"content\": \"${IPADDR}\",
        \"ttl\": 1,
        \"proxied\": true
    }")

fi

if [ "$(echo "$VAL_RESULT" | jq '.success')" == false ]; then
    echo "$VAL_RESULT" | jq '.errors[0].message'
    exit 1
fi
echo "${FULLHOST} successfully ${METHOD} to Cloudflare"
echo "$VAL_RESULT"
