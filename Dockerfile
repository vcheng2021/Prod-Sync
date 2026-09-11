FROM node:22-bookworm-slim AS builder

WORKDIR /app

COPY package*.json ./
COPY client/package*.json ./client/
COPY server/tsconfig.json ./server/

RUN apt-get update \
  && apt-get install --no-install-recommends -y python3 make g++ git \
  && npm ci \
  && npm ci --prefix client \
  && rm -rf /var/lib/apt/lists/*

COPY client ./client
COPY server ./server
COPY suppliers ./suppliers

# VIC-23: Capture git commit hash for auto-versioning
RUN echo "$(git rev-parse HEAD 2>/dev/null || echo unknown)" > /tmp/build-commit.txt

RUN npm run build

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
ENV PORT=8787
ENV APP_VERSION=0.1.0
ENV DATABASE_PATH=/app/data/ecomint.db
ENV PRODUCT_IMAGE_DIRECTORY=/app/productimage
ENV LOG_DIRECTORY=/app/logs

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/client/dist ./client/dist
COPY --from=builder /app/server/dist ./server/dist
COPY --from=builder /app/suppliers ./suppliers
# VIC-23: Build-time git commit fingerprint for auto-versioning
COPY --from=builder /tmp/build-commit.txt /app/.build-commit

RUN mkdir -p /app/data /app/logs /app/productimage

EXPOSE 8787

HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "const p=process.env.PORT||'8787';require('http').get('http://127.0.0.1:'+p+'/api/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "server/dist/index.js"]
