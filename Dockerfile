# ═══════════════════════════════════════════════════════════════════════════════
# Dockerfile para Fotocorredor API + Worker
# Optimizado para DigitalOcean App Platform
# ═══════════════════════════════════════════════════════════════════════════════

FROM node:20-alpine AS builder

# Instalar dependencias del sistema para canvas, sharp, argon2
RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    cairo-dev \
    pango-dev \
    jpeg-dev \
    giflib-dev \
    librsvg-dev \
    pixman-dev \
    libc6-compat

WORKDIR /app

# Copiar archivos de dependencias
COPY package*.json ./
COPY apps/api/package*.json ./apps/api/
COPY apps/worker/package*.json ./apps/worker/

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
FROM node:20-alpine AS runner

# Librerías runtime
RUN apk add --no-cache \
    cairo \
    pango \
    jpeg \
    giflib \
    librsvg \
    pixman \
    libc6-compat \
    dumb-init

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
