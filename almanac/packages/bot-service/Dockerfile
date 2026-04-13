FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json tsconfig.base.json ./
COPY packages/bot-service/package.json packages/bot-service/
COPY packages/bot-service/tsconfig.json packages/bot-service/
COPY packages/bot-service/src/ packages/bot-service/src/
COPY packages/rag-pipeline/package.json packages/rag-pipeline/
COPY packages/rag-pipeline/tsconfig.json packages/rag-pipeline/
COPY packages/rag-pipeline/src/ packages/rag-pipeline/src/
COPY packages/identity-service/package.json packages/identity-service/
COPY packages/identity-service/tsconfig.json packages/identity-service/
COPY packages/identity-service/src/ packages/identity-service/src/
RUN npm ci --workspace=packages/bot-service
RUN npm run build --workspace=packages/bot-service

FROM node:20-alpine AS runtime
RUN addgroup -g 1001 almanac && adduser -u 1001 -G almanac -s /bin/sh -D almanac
WORKDIR /app
COPY --from=builder /app/packages/bot-service/dist ./dist
COPY --from=builder /app/packages/bot-service/package.json ./
RUN npm ci --omit=dev
USER almanac
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://localhost:3000/health || exit 1
CMD ["node", "dist/index.js"]
