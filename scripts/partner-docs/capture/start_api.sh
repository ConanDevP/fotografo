#!/bin/zsh
# Arranca la API compilada (dist/) contra la base de pruebas, sin tocar tu .env ni tu base real.
# Se ejecuta desde un directorio aparte para que dotenv no cargue el .env del repositorio.
REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
RUN="${RUN_DIR:-/tmp/lucilamon-docs-run}"
mkdir -p "$RUN/apps/api/src/assets" "$RUN/docs" && cp -R "$REPO/apps/api/src/assets/fonts" "$RUN/apps/api/src/assets/" && cp "$REPO/docs/partner-openapi.yaml" "$RUN/docs/"
cd "$RUN"
pkill -f "dist/apps/api/main" 2>/dev/null; sleep 1
export JWT_PRIVATE_KEY="$(cat "$REPO/private.pem")" JWT_PUBLIC_KEY="$(cat "$REPO/public.pem")"
env NODE_ENV=development PORT=3333 DATABASE_URL="postgresql://postgres:docs@localhost:55433/lm_docs_test" REDIS_URL="redis://localhost:6379/9" \
  FRONTEND_URL="http://localhost:3000" API_URL="http://localhost:3333" APP_URL="http://localhost:3000" CORS_ORIGINS="http://localhost:3000" \
  ORDER_ACCESS_SECRET="docs-order-secret-0123456789abcdef0123" METRICS_HASH_SECRET="docs-metrics-secret-0123456789abcdef0123" \
  FACE_API_KEY="docs-face-key-0123456789abcdef0123456789" PARTNER_WEBHOOK_ENCRYPTION_KEY="docs-webhook-enc-key-0123456789abcdef0123" \
  STORAGE_PROVIDER=r2 R2_ACCOUNT_ID=docsaccount R2_ACCESS_KEY_ID=docskey R2_SECRET_ACCESS_KEY=docssecret R2_BUCKET_NAME=docs-private \
  R2_PUBLIC_BUCKET_NAME=docs-public R2_PUBLIC_URL="https://pub.docs.example" LOG_LEVEL=warn node "$REPO/dist/apps/api/main.js" > "$RUN/api.log" 2>&1 &
