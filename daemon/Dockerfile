# The daemon runs the SDK from the sources of this repository, so the image is built from the
# repository root:
#   docker build -f daemon/Dockerfile -t guardian-daemon .
# Pinned by digest, so one revision builds on the same base image every time.
FROM docker.io/lidofinance/dhi-node:24.22.1-alpine3.24-dev@sha256:7b851ff65d774343caf89450555663caef54dbd8f673658a615d256883973337 AS dependencies

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

FROM docker.io/lidofinance/dhi-node:24.22.1-alpine3.24@sha256:a23617dcacb063a973d6a989430a5cc007e4d5ae9042fa884a7426a6be7e0037

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
ENTRYPOINT []
CMD ["node", "daemon/main.ts"]
