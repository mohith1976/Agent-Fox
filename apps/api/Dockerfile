# Agent Fox API — dev (watch) and prod (dist) targets.
# Build context MUST be the repo root (npm workspaces need every package.json).
ARG NODE_VERSION=22

FROM node:${NODE_VERSION}-slim AS base
# Prisma engines need OpenSSL at runtime.
RUN apt-get update && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists
WORKDIR /app

# ---- dependencies (all workspaces; build needs nest CLI + prisma CLI) ----
FROM base AS deps
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm ci

# ---- build the API + generate the Prisma client ----
FROM deps AS build
COPY prisma ./prisma
COPY prisma7.config.ts ./
RUN ./node_modules/.bin/prisma generate
COPY apps/api ./apps/api
RUN npm run build --workspace=apps/api

# ---- dev: hot-reload, source bind-mounted by compose ----
FROM deps AS dev
COPY prisma ./prisma
COPY prisma7.config.ts ./
RUN ./node_modules/.bin/prisma generate
COPY . .
CMD ["npm", "run", "start:dev:docker", "--workspace=apps/api"]

# ---- prod: compiled dist only (migrations run via start:prod entrypoint) ----
FROM base AS prod
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/api/package.json ./apps/api/package.json
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/prisma7.config.ts ./prisma7.config.ts
EXPOSE 3009
CMD ["npm", "run", "start:prod", "--workspace=apps/api"]
