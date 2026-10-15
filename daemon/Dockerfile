# The daemon runs the SDK from the sources of this repository, so the image is built from the
# repository root:
#   docker build -f daemon/Dockerfile -t guardian-daemon .
FROM node:24-slim

WORKDIR /app

# viem is the only runtime dependency; the SDK itself runs from its TypeScript sources.
COPY daemon/package.json daemon/package-lock.json ./
RUN npm ci

COPY abi ./abi
COPY src ./src
COPY example/env.ts ./example/env.ts
COPY daemon ./daemon

USER node
CMD ["node", "daemon/main.ts"]
