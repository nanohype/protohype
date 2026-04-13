# Multi-stage build — production image < 200MB
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci --include=dev
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app

# Non-root user for security
RUN addgroup -g 1001 -S acmeask && adduser -u 1001 -S acmeask -G acmeask

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder --chown=acmeask:acmeask /app/dist ./dist

USER acmeask
EXPOSE 3000

# Health check baked into image
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["node", "dist/index.js"]
