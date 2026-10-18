# syntax=docker/dockerfile:1.7
# Multi-stage build for polymarket-agents (Next.js 15 + better-sqlite3).
#
# Image goals:
#   - reproducible: pinned node version
#   - small-ish: production deps + .next only in the runtime stage
#   - native-build-clean: build tools live in `deps`, never in `runner`
#
# better-sqlite3 needs python3 + a C++ toolchain at install time but NOT at
# runtime (the prebuilt .node binary ships in node_modules). We install those
# in the `deps` stage and discard them.
#
# SQLite persistence is via a bind/volume mount on /app/data. See
# DEPLOY_RUNBOOK.md for the docker-compose example.

ARG NODE_VERSION=22.13.0
FROM node:${NODE_VERSION}-bookworm-slim AS base
WORKDIR /app
ENV NODE_ENV=production

# ---------- deps: install all deps including dev, with build toolchain ----
FROM base AS deps
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --include=dev

# ---------- build: produce .next bundle ----------
FROM deps AS build
COPY . .
# Skip telemetry; lints inside CI rather than at image-build time
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ---------- runtime: production node_modules + .next + scripts -----------
FROM base AS runner
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
# Re-install only production deps so we drop python3/g++ from the image.
COPY package.json package-lock.json ./
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 make g++ \
    && npm ci --omit=dev \
    && apt-get purge -y python3 make g++ \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/.next ./.next
COPY --from=build /app/next.config.mjs ./next.config.mjs
COPY --from=build /app/postcss.config.mjs ./postcss.config.mjs
COPY --from=build /app/tailwind.config.ts ./tailwind.config.ts
COPY --from=build /app/tsconfig.json ./tsconfig.json
COPY --from=build /app/src ./src
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/docs ./docs
COPY --from=build /app/public ./public

# Persistent SQLite directory. Mount a volume here on the host to keep
# data/polymarket.db across container restarts.
RUN mkdir -p /app/data
VOLUME ["/app/data"]

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://localhost:${PORT}/ || exit 1

CMD ["npm", "run", "start"]
