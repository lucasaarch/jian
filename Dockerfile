FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
# The Git hooks are not installed in an image, and pnpm must not prune devDependencies
# before the build runs.
ENV HUSKY=0 CI=true
# Manifests and the lockfile come first so the dependency layer is reused on every commit
# that only changes source.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY .husky/install.mjs .husky/install.mjs
COPY apps/gateway/package.json apps/gateway/package.json
COPY apps/gateway-ui/package.json apps/gateway-ui/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/sdk/package.json packages/sdk/package.json
RUN pnpm install --frozen-lockfile
COPY apps/gateway apps/gateway
COPY apps/gateway-ui apps/gateway-ui
COPY packages packages
# `deploy` writes a self-contained tree: the gateway's compiled output, the panel exported
# into it, and production dependencies with the workspace links resolved to real files.
RUN pnpm build && pnpm --filter @jian/gateway --prod deploy --legacy /runtime

FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
ARG JIAN_VERSION=0.0.0-dev
ARG JIAN_REVISION=unknown
# Standard annotations: GHCR links the package to the repository through `source`, and the
# other two say which commit produced the bits. CI overrides them with the same values.
LABEL org.opencontainers.image.title="Jian Gateway" \
      org.opencontainers.image.description="Self-hosted agent gateway" \
      org.opencontainers.image.source="https://github.com/lucasaarch/jian" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.version="${JIAN_VERSION}" \
      org.opencontainers.image.revision="${JIAN_REVISION}"
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4310
WORKDIR /app
# Only the deployed tree crosses over: no sources, no toolchain, no pnpm store.
COPY --from=build --chown=node:node /runtime ./
USER node
EXPOSE 4310
# Node ships fetch, so the check installs nothing. It honours PORT because the container
# may be started on another one.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||4310)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/main.js"]
