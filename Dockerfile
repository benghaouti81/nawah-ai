FROM node:22-bookworm-slim AS base
WORKDIR /app

# Install native build dependencies for better-sqlite3 fallback compilation and CA certificates
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* bun.lock* ./
RUN npm install && npm cache clean --force

COPY . .
RUN npm run build

ENV NODE_ENV=production
ENV PORT=3000
ENV NAWAH_DATA_DIR=/app/data

RUN mkdir -p /app/data

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["./node_modules/.bin/tsx", "server.ts"]
