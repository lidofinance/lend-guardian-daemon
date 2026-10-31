# The daemon runs the SDK from the sources of this repository, so the image is built from the
# repository root:
#   docker build -f daemon/Dockerfile -t guardian-daemon .
# Pinned by digest, so one revision builds on the same base image every time.
FROM node:24.22.1-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205

WORKDIR /app

# viem is the only runtime dependency; the SDK itself runs from its TypeScript sources.
COPY daemon/package.json daemon/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY abi ./abi
COPY src ./src
# The daemon runs the example's Guardian and schedule; the example's entry point and placeholder stay out.
COPY example/guardian.ts example/env.ts ./example/
COPY daemon ./daemon

USER node
CMD ["node", "daemon/main.ts"]
