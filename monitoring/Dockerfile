# The monitoring receiver: the daemon posts its events here and Prometheus scrapes /metrics. Built from
# the repository root like the daemon image:
#   docker build -f monitoring/Dockerfile -t guardian-monitoring .
# Pinned by digest, as the daemon's base image, so one revision builds on the same base every time.
FROM docker.io/lidofinance/dhi-node:24.22-alpine3.24-dev@sha256:42930a1523f7213e7d7bcf033e2c5e26f08db09b42f77a8de68e6a26f741e264 AS dependencies

ENV NODE_ENV=production

WORKDIR /app

COPY monitoring/package.json monitoring/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

# The build workflow passes these; a local build reports them as unknown.
ARG BUILD_VERSION=unknown
ARG BUILD_BRANCH=unknown
ARG BUILD_COMMIT=unknown
RUN node -e 'require("node:fs").writeFileSync("build-info.json", JSON.stringify({ version: process.env.BUILD_VERSION, branch: process.env.BUILD_BRANCH, commit: process.env.BUILD_COMMIT }))'

FROM docker.io/lidofinance/dhi-node:24.22-alpine3.24@sha256:4544851709621aa77a18134101ef4cd6af39233cf57bdfe2adcc17e2e72866db

ENV NODE_ENV=production
WORKDIR /app

COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=dependencies /app/build-info.json ./build-info.json
COPY monitoring/package.json ./
# Type-only imports of daemon and SDK modules are erased by Node.
COPY monitoring/*.ts ./monitoring/

USER 1000:1000

EXPOSE 9464

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.MONITOR_PORT ?? 9464}/health`).then((response) => process.exit(response.ok ? 0 : 1), () => process.exit(1))"]

ENTRYPOINT []
CMD ["node", "monitoring/main.ts"]
