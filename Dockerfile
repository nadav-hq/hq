# NADAV HQ engine (Railway). Build context: repo root.
FROM node:22-bookworm-slim

# pg_dump/psql 17 for export-company (Supabase runs Postgres 17), CA bundle for TLS, git for card versions.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl gnupg git postgresql-common \
 && /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y \
 && apt-get install -y --no-install-recommends postgresql-client-17 \
 && rm -rf /var/lib/apt/lists/*
ENV PG_DUMP=/usr/lib/postgresql/17/bin/pg_dump

RUN corepack enable
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY shared/package.json shared/
COPY engine/package.json engine/
RUN pnpm install --frozen-lockfile

COPY . .

CMD ["pnpm", "engine:start"]
