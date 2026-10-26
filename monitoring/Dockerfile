# The monitoring receiver: the daemon posts its events here and Prometheus scrapes /metrics. Built from
# the repository root like the daemon image:
#   docker build -f monitoring/Dockerfile -t guardian-monitoring .
FROM node:24-slim AS dependencies

WORKDIR /app

COPY monitoring/package.json monitoring/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force

FROM node:24-slim

ENV NODE_ENV=production

WORKDIR /app

COPY --from=dependencies /app/node_modules ./node_modules
COPY monitoring/package.json ./package.json
# The receiver's type-only import of src/events.ts is erased when Node runs the TypeScript source.
COPY monitoring ./monitoring

# The shared build workflow passes these; a local build keeps the placeholders, reported as the build.
ARG BUILD_VERSION=REPLACE_WITH_VERSION
ARG BUILD_BRANCH=REPLACE_WITH_BRANCH
ARG BUILD_COMMIT=REPLACE_WITH_COMMIT
RUN printf '{"version":"%s","branch":"%s","commit":"%s"}\n' "$BUILD_VERSION" "$BUILD_BRANCH" "$BUILD_COMMIT" > build-info.json

USER node

EXPOSE 9464

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.MONITOR_PORT ?? 9464}/health`).then((response) => process.exit(response.ok ? 0 : 1), () => process.exit(1))"]

CMD ["node", "monitoring/main.ts"]
