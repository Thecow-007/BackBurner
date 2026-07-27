# BackBurner production image — docs/deployment.md §2.
#
# Two stages on Node 22, the same runtime as local dev and CI:
#
#   build   — installs the full workspace dependency tree and builds
#             engine, api, and web (in that order, via scripts/build.mjs).
#   runtime — production dependencies, built output, migrations/, and the
#             two scripts the entrypoint needs. No sources, no toolchain.
#
# The runtime layout is NOT free-form. packages/api/dist/server.js resolves
# the repo root as three levels up from its own directory and reads
# `migrations/` and `packages/web/dist` from there (see server.ts). The COPY
# targets below reproduce that layout exactly; moving any of them breaks
# migration verification or silently stops serving the dashboard.

# ---------------------------------------------------------------- build ----
FROM node:22-slim AS build

WORKDIR /app

# Manifests first, so the dependency layer caches independently of sources.
# Every workspace listed in package-lock.json must be present or `npm ci`
# rejects the lockfile as unsatisfied — including e2e, which contributes
# nothing to the image but does contribute to the lock.
COPY package.json package-lock.json ./
COPY packages/engine/package.json packages/engine/
COPY packages/api/package.json packages/api/
COPY packages/web/package.json packages/web/
COPY packages/e2e/package.json packages/e2e/

RUN npm ci

COPY tsconfig.base.json tsconfig.json ./
COPY scripts/ scripts/
COPY packages/ packages/

RUN npm run build

# -------------------------------------------------------------- runtime ----
FROM node:22-slim AS runtime

ENV NODE_ENV=production

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/engine/package.json packages/engine/
COPY packages/api/package.json packages/api/
COPY packages/web/package.json packages/web/
COPY packages/e2e/package.json packages/e2e/

# --omit=dev drops the toolchain (tsc, vite, vitest) but keeps the workspace
# symlinks npm creates under node_modules/@backburner, which is how the api's
# `import "@backburner/engine"` resolves to packages/engine/dist.
RUN npm ci --omit=dev && npm cache clean --force

# Migrations and the three scripts the runtime needs. The api verifies at boot
# that every file here is recorded in schema_migrations, so this directory is
# load-bearing, not documentation (architecture.md §13).
#
# seed.mjs earns its place: raw API keys are printed exactly once and are
# unrecoverable afterward, so provisioning the reviewer's key on the deployed
# instance has to happen *there* —
#   docker compose exec app node scripts/seed.mjs --tasks 300
# It composes packages/engine/dist/seed.js and packages/api/dist/users.js,
# both already present below, and needs nothing else from the build stage.
COPY migrations/ migrations/
COPY scripts/migrate.mjs scripts/start.mjs scripts/seed.mjs scripts/

COPY --from=build /app/packages/engine/dist packages/engine/dist
COPY --from=build /app/packages/api/dist packages/api/dist
COPY --from=build /app/packages/web/dist packages/web/dist

# The node image ships an unprivileged `node` user (uid 1000). Nothing in the
# image is written at runtime, so read-only ownership by root is correct.
USER node

EXPOSE 3000

# Exec form, no shell wrapper: node is PID 1 and therefore receives Docker's
# SIGTERM directly. That is what makes server.ts's graceful-drain handler fire
# on `docker stop` instead of the process being torn down mid-job.
CMD ["node", "scripts/start.mjs"]
