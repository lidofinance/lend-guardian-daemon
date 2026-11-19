# The daemon runs the SDK from the sources of this repository, so the image is built from the
# repository root:
#   docker build -f daemon/Dockerfile -t guardian-daemon .
# Pinned by digest, so one revision builds on the same base image every time.
FROM dhi.io/node:24.22-alpine3.24-dev@sha256:42930a1523f7213e7d7bcf033e2c5e26f08db09b42f77a8de68e6a26f741e264 AS dependencies

WORKDIR /app

# viem is the only runtime dependency; the SDK itself runs from its TypeScript sources.
COPY daemon/package.json daemon/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

# The build workflow passes these; a local build reports them as unknown. The daemon reads the file
# at start and sends the version in its User-Agent.
ARG BUILD_VERSION=unknown
ARG BUILD_BRANCH=unknown
ARG BUILD_COMMIT=unknown
RUN node -e 'require("node:fs").writeFileSync("build-info.json", JSON.stringify({ version: process.env.BUILD_VERSION, branch: process.env.BUILD_BRANCH, commit: process.env.BUILD_COMMIT }))'

FROM dhi.io/node:24.22-alpine3.24@sha256:4544851709621aa77a18134101ef4cd6af39233cf57bdfe2adcc17e2e72866db

ENV NODE_ENV=production
WORKDIR /app

COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=dependencies /app/build-info.json ./build-info.json
COPY daemon/package.json ./
COPY abi ./abi
COPY src ./src
COPY example/guardian.ts example/configuration.ts example/secrets.ts ./example/
COPY daemon/*.ts ./daemon/

# Keep the UID used by the Helm securityContext and mounted secrets.
USER 1000:1000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.HEALTH_PORT ?? 8080}/health`).then((response) => process.exit(response.ok ? 0 : 1), () => process.exit(1))"]

ENTRYPOINT []
CMD ["node", "daemon/main.ts"]
