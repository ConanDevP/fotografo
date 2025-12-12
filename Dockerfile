# ═══════════════════════════════════════════════════════════════════════════════
# Dockerfile para Fotocorredor API + Worker
# Usando Debian para mejor compatibilidad con canvas, sharp, argon2
# ═══════════════════════════════════════════════════════════════════════════════

FROM node:20-slim AS builder

# Instalar dependencias del sistema para canvas, sharp, argon2
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    libcairo2-dev \
    libpango1.0-dev \
    libjpeg-dev \
    libgif-dev \
    librsvg2-dev \
    libpixman-1-dev \
    pkg-config \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copiar archivos de dependencias
COPY package*.json ./
COPY apps/api/package*.json ./apps/api/

# Instalar dependencias
RUN npm ci --legacy-peer-deps

# Copiar código fuente
COPY . .

# Generar Prisma Client
RUN npx prisma generate --schema=./apps/api/prisma/schema.prisma

# Build
RUN npm run build

# ─────────────────────────────────────────────────────────────────────────────
# Production
# ─────────────────────────────────────────────────────────────────────────────
FROM node:20-slim AS runner

# Librerías runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
    libcairo2 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libjpeg62-turbo \
    libgif7 \
    librsvg2-2 \
    libpixman-1-0 \
    dumb-init \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copiar build y dependencias
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/apps/api/prisma ./prisma
COPY --from=builder /app/package.json ./

ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/apps/api/main"]
