#!/bin/sh

set -eu

RUNTIME_DIR="${DEMO_RUNTIME_DIR:-/app/runtime}"
SECRETS_FILE="${RUNTIME_DIR}/demo-secrets.env"

mkdir -p "${RUNTIME_DIR}"

persisted_encryption_key=""
persisted_jwt_secret=""

if [ -f "${SECRETS_FILE}" ]; then
    persisted_encryption_key="$(sed -n 's/^ENCRYPTION_KEY=//p' "${SECRETS_FILE}" | head -n 1)"
    persisted_jwt_secret="$(sed -n 's/^JWT_SECRET=//p' "${SECRETS_FILE}" | head -n 1)"
fi

ENCRYPTION_KEY="${ENCRYPTION_KEY:-${persisted_encryption_key}}"
JWT_SECRET="${JWT_SECRET:-${persisted_jwt_secret}}"

if [ -z "${ENCRYPTION_KEY}" ]; then
    ENCRYPTION_KEY="$(openssl rand -base64 32)"
fi

if [ -z "${JWT_SECRET}" ]; then
    JWT_SECRET="$(openssl rand -base64 32)"
fi

umask 077
cat > "${SECRETS_FILE}" <<EOF
ENCRYPTION_KEY=${ENCRYPTION_KEY}
JWT_SECRET=${JWT_SECRET}
EOF

export ENCRYPTION_KEY
export JWT_SECRET

exec tsx ./server.ts
