# The monitoring receiver: the daemon posts its events here and Prometheus scrapes /metrics. Built from
# the repository root like the daemon image:
#   docker build -f monitoring/Dockerfile -t guardian-monitoring .
# Pinned by digest, as the daemon's base image, so one revision builds on the same base every time.
FROM node:24.22.1-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205

ENV NODE_ENV=production

WORKDIR /app

COPY monitoring/package.json monitoring/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force

# The receiver's type-only imports of the daemon's and the SDK's events are erased when Node runs the
# TypeScript source, so only its own modules are copied; its guide and this file stay out.
COPY monitoring/*.ts ./monitoring/

# The build workflow passes these; a local build reports them as unknown.
ARG BUILD_VERSION=unknown
ARG BUILD_BRANCH=unknown
ARG BUILD_COMMIT=unknown
RUN node -e 'require("node:fs").writeFileSync("build-info.json", JSON.stringify({ version: process.env.BUILD_VERSION, branch: process.env.BUILD_BRANCH, commit: process.env.BUILD_COMMIT }))'

USER node

EXPOSE 9464

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.MONITOR_PORT ?? 9464}/health`).then((response) => process.exit(response.ok ? 0 : 1), () => process.exit(1))"]

CMD ["node", "monitoring/main.ts"]
