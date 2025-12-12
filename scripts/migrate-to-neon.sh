#!/bin/bash

# ═══════════════════════════════════════════════════════════════════════════════
# Script de Migración a Neon PostgreSQL
# ═══════════════════════════════════════════════════════════════════════════════

set -e

echo "🚀 Migración a Neon PostgreSQL"
echo "═══════════════════════════════════════════════════════════════════════════════"

# Colores
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Verificar que estamos en el directorio correcto
if [ ! -f "package.json" ]; then
    echo -e "${RED}❌ Error: Ejecuta este script desde la raíz del proyecto (donde está package.json)${NC}"
    exit 1
fi

# Verificar que existe el archivo .env
if [ ! -f ".env" ]; then
    echo -e "${RED}❌ Error: No se encontró el archivo .env${NC}"
    echo -e "${YELLOW}Crea un archivo .env basado en .env.example${NC}"
    exit 1
fi

# Leer DATABASE_URL del .env
source .env

if [ -z "$DATABASE_URL" ]; then
    echo -e "${RED}❌ Error: DATABASE_URL no está definida en .env${NC}"
    exit 1
fi

# Verificar que es una URL de Neon
if [[ "$DATABASE_URL" != *"neon.tech"* ]]; then
    echo -e "${YELLOW}⚠️  Advertencia: DATABASE_URL no parece ser de Neon${NC}"
    echo -e "URL actual: ${BLUE}$DATABASE_URL${NC}"
    echo ""
    read -p "¿Continuar de todos modos? (y/n): " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
    fi
fi

echo -e "${GREEN}✓ DATABASE_URL configurada${NC}"
echo ""

# Paso 1: Generar cliente Prisma
echo -e "${BLUE}📦 Paso 1: Generando cliente Prisma...${NC}"
cd apps/api
npx prisma generate
echo -e "${GREEN}✓ Cliente Prisma generado${NC}"
echo ""

# Paso 2: Verificar conexión
echo -e "${BLUE}🔌 Paso 2: Verificando conexión a la base de datos...${NC}"
npx prisma db execute --stdin <<< "SELECT 1;" > /dev/null 2>&1 && echo -e "${GREEN}✓ Conexión exitosa${NC}" || {
    echo -e "${RED}❌ Error: No se pudo conectar a la base de datos${NC}"
    echo -e "${YELLOW}Verifica que:${NC}"
    echo "  1. La URL de conexión es correcta"
    echo "  2. Estás usando la URL 'pooled' (con -pooler en el host)"
    echo "  3. La contraseña no tiene caracteres especiales sin escapar"
    exit 1
}
echo ""

# Paso 3: Aplicar migraciones
echo -e "${BLUE}🗄️  Paso 3: Aplicando migraciones...${NC}"
if [ -d "prisma/migrations" ] && [ "$(ls -A prisma/migrations)" ]; then
    echo "Encontradas migraciones existentes, aplicando..."
    npx prisma migrate deploy
else
    echo "No hay migraciones, sincronizando schema..."
    npx prisma db push
fi
echo -e "${GREEN}✓ Base de datos sincronizada${NC}"
echo ""

# Paso 4: Habilitar pgvector (para embeddings faciales)
echo -e "${BLUE}🧠 Paso 4: Habilitando extensión pgvector...${NC}"
npx prisma db execute --stdin <<< "CREATE EXTENSION IF NOT EXISTS vector;" 2>/dev/null || echo -e "${YELLOW}⚠️  pgvector ya está habilitado o no está disponible${NC}"
echo -e "${GREEN}✓ pgvector configurado${NC}"
echo ""

# Paso 5: Verificar tablas
echo -e "${BLUE}📊 Paso 5: Verificando tablas creadas...${NC}"
TABLE_COUNT=$(npx prisma db execute --stdin <<< "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public';" 2>/dev/null | grep -oE '[0-9]+' | head -1)
echo -e "${GREEN}✓ $TABLE_COUNT tablas encontradas${NC}"
echo ""

# Resumen
echo "═══════════════════════════════════════════════════════════════════════════════"
echo -e "${GREEN}🎉 ¡Migración completada exitosamente!${NC}"
echo ""
echo "Próximos pasos:"
echo "  1. Ejecuta 'npm run start:dev' para iniciar el servidor"
echo "  2. Prueba la conexión con una petición a la API"
echo "  3. Verifica el dashboard de Neon para monitoreo"
echo ""
echo -e "${BLUE}Dashboard: https://console.neon.tech${NC}"
echo "═══════════════════════════════════════════════════════════════════════════════"
