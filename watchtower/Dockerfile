FROM node:24-alpine AS builder
WORKDIR /app

# Build each file:-linked package first so the root npm ci can resolve them.
COPY packages ./packages
RUN set -e; for pkg in packages/*/; do \
      (cd "$pkg" && npm ci && npm run build); \
    done

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ── Runtime image ────────────────────────────────────────────────────────────
FROM node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

# OTel auto-instrumentation: the --require hook loads the SDK +
# instrumentations before user code, so http/fetch/aws-sdk/pg spans are
# captured automatically. Target is the ADOT sidecar at localhost:4317.
ENV NODE_OPTIONS="--require @opentelemetry/auto-instrumentations-node/register"

RUN addgroup -g 1001 -S watchtower && adduser -u 1001 -S watchtower -G watchtower

COPY --from=builder /app/packages ./packages
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist

USER watchtower
EXPOSE 9090

# Health probe hits the /health endpoint served by src/health/server.ts.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:9090/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "dist/index.js"]
