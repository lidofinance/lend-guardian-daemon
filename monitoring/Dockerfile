# The monitoring receiver: the daemon posts its events here, Prometheus scrapes /metrics. Built from the
# repository root like the daemon image:
#   docker build -f monitoring/Dockerfile -t guardian-monitoring .
FROM node:24-alpine AS dependencies
WORKDIR /app
COPY monitoring/package.json monitoring/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force

FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY monitoring/package.json ./package.json
COPY monitoring ./monitoring

# The shared build workflow passes these; a local build keeps the placeholders.
ARG BUILD_VERSION=REPLACE_WITH_VERSION
ARG BUILD_BRANCH=REPLACE_WITH_BRANCH
ARG BUILD_COMMIT=REPLACE_WITH_COMMIT
RUN node -e 'const fs = require("node:fs"); const [version, branch, commit] = process.argv.slice(1); fs.writeFileSync("build-info.json", JSON.stringify({version, branch, commit}) + "\n")' "$BUILD_VERSION" "$BUILD_BRANCH" "$BUILD_COMMIT"

USER 1000:1000
EXPOSE 9464
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD wget -qO- http://127.0.0.1:${MONITOR_PORT:-9464}/health || exit 1
ENTRYPOINT ["node", "monitoring/main.ts"]
