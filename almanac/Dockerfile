FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json turbo.json ./
COPY packages/ai/package*.json ./packages/ai/
COPY packages/api/package*.json ./packages/api/
COPY packages/connectors/package*.json ./packages/connectors/
RUN npm ci
COPY packages/ ./packages/
COPY tsconfig.base.json ./
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/packages/ai/dist ./packages/ai/dist
COPY --from=builder /app/packages/api/dist ./packages/api/dist
COPY --from=builder /app/packages/connectors/dist ./packages/connectors/dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/ai/node_modules ./packages/ai/node_modules
COPY --from=builder /app/packages/api/node_modules ./packages/api/node_modules
COPY --from=builder /app/packages/connectors/node_modules ./packages/connectors/node_modules
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1
USER node
CMD ["node", "packages/api/dist/app.js"]
