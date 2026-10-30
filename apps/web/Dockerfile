# syntax=docker/dockerfile:1
# The panel's server: Next.js in standalone mode, in front of the gateway. Built from the
# repository root (`make image`), because the panel compiles against the workspace contracts.
FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
ENV HUSKY=0 CI=true NEXT_TELEMETRY_DISABLED=1
# Manifests and the lockfile first, so the dependency layer survives a source-only change.
# Only the panel and what it imports are installed: none of the gateway's runtime.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY .husky/install.mjs .husky/install.mjs
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/sdk/package.json packages/sdk/package.json
COPY packages/ui/package.json packages/ui/package.json
RUN pnpm install --frozen-lockfile --filter @jian/web...
COPY packages packages
COPY apps/web apps/web
RUN pnpm --filter @jian/contracts build \
 && pnpm --filter @jian/sdk build \
 && pnpm --filter @jian/web build

FROM node:24-bookworm-slim
ARG JIAN_VERSION=0.0.0-dev
ARG JIAN_REVISION=unknown
LABEL org.opencontainers.image.title="Jian Web" \
      org.opencontainers.image.description="The Jian panel, in front of the Jian gateway" \
      org.opencontainers.image.source="https://github.com/lucasaarch/jian" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.version="${JIAN_VERSION}" \
      org.opencontainers.image.revision="${JIAN_REVISION}"
# JIAN_GATEWAY_URL is read on every request, so one image serves any topology; the default
# is the service name compose.yaml gives the gateway.
# JIAN_VERSION is this image's release, compared with the gateway's on every page: two
# releases never run together.
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000 \
    JIAN_GATEWAY_URL=http://gateway:4310 JIAN_VERSION=${JIAN_VERSION}
WORKDIR /app
# The standalone tree carries its own pruned node_modules, and the build placed the static
# assets and public/ inside it (scripts/standalone.mjs).
COPY --from=build --chown=node:node /app/apps/web/.next/standalone ./
USER node
EXPOSE 3000
# This server's own liveness: a gateway restart must not take the web container down with it.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/web/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "apps/web/server.js"]
