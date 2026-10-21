FROM docker:29-cli AS docker-cli

FROM --platform=$BUILDPLATFORM ghcr.io/voidzero-dev/vite-plus:1.3.0 AS build
WORKDIR /app
COPY --chown=vp:vp package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN vp install --frozen-lockfile
COPY --chown=vp:vp . .
RUN vp pack

FROM node:24-alpine AS base
# `apk upgrade` pulls security fixes published after the base image was built.
# npm, corepack and yarn are unused at runtime and each ships its own
# vulnerable dependency tree, so drop them.
RUN apk upgrade --no-cache \
    && apk add --no-cache dumb-init openssl \
    && rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx \
        /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-*
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker-cli /usr/local/libexec/docker/cli-plugins/docker-compose /usr/local/libexec/docker/cli-plugins/docker-compose
WORKDIR /app
EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.SERVER_PORT||80)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/dumb-init", "--"]

# compose-dev.yaml: full dependency tree (incl. tsx) with the source bind-mounted.
FROM base AS dev
ENV PATH=/app/node_modules/.bin:$PATH
COPY --from=build /app/node_modules ./node_modules
CMD ["tsx", "watch", "./server.ts"]

# Production: the bundled server plus the files it reads at runtime. No node_modules.
FROM base AS release
COPY --from=build /app/dist ./dist
COPY views ./views
COPY public ./public
COPY scripts ./scripts
COPY compose-demo.yaml ./
CMD ["sh", "./scripts/start-demo-kuma.sh"]
