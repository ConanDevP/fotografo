#!/bin/bash
# Regenera y publica la documentación de la Partner API.
#   1) docs/partner-openapi.yaml   (desde el código, examples.json y los textos)
#   2) docs/partner/REFERENCE.md y WEBHOOKS.md
#   3) página de referencia (Redoc), copia del OpenAPI y colección de Postman en el frontend
# Uso: bash scripts/partner-docs/publish.sh [ruta-al-frontend]
set -euo pipefail
cd "$(dirname "$0")/../.."
FRONT="${1:-../../sports-photography-platform (1)}"
python3 scripts/partner-docs/build_openapi.py
python3 scripts/partner-docs/build_reference_md.py
npx --yes @redocly/cli@1.25.15 lint docs/partner-openapi.yaml
if [ -d "$FRONT/public" ]; then
  OUT="$FRONT/public/developers"; mkdir -p "$OUT"
  npx --yes @redocly/cli@1.25.15 build-docs docs/partner-openapi.yaml --config scripts/partner-docs/redocly.yaml -o "$OUT/reference.html" --title "LucilaMon Partner API — Referencia"
  [ -f "$OUT/redoc.standalone.js" ] || curl -sL -o "$OUT/redoc.standalone.js" https://cdn.redocly.com/redoc/v2.2.0/bundles/redoc.standalone.js
  python3 - "$OUT/reference.html" <<'PY'
import sys
p = sys.argv[1]
s = open(p, encoding='utf-8').read().replace('https://cdn.redocly.com/redoc/v2.2.0/bundles/redoc.standalone.js', '/developers/redoc.standalone.js')
open(p, 'w', encoding='utf-8').write(s)
PY
  cp docs/partner-openapi.yaml "$OUT/openapi.yaml"
  npx --yes openapi-to-postmanv2@4.25.0 -s docs/partner-openapi.yaml -o "$OUT/lucilamon-partner.postman_collection.json" -p -O folderStrategy=Tags,requestParametersResolution=Example,exampleParametersResolution=Example
  echo "Publicado en $OUT"
else
  echo "No se encontró el frontend en '$FRONT': se generó solo docs/. Pasa la ruta como primer argumento."
fi
