# POC Black Jack 
## Prerequisites

- [Bun](https://bun.sh) (developed against 1.3.x)
- A PostgreSQL database (for the dealer-sign game state)
- An Enoki account (secret + public API keys), a Google OAuth client ID

## Install

```bash
cd app-vite
bun install
```

## Environment

Two `.env` files, copied from the examples and filled in. Most values can be lifted from
`../app/.env` — note the client variables change prefix from `NEXT_PUBLIC_` to `VITE_`.

**`packages/server/.env`** (secrets — never commit):

```bash
cp packages/server/.env.example packages/server/.env
```
Fill: `POSTGRES_PRISMA_URL`, `ENOKI_SECRET_KEY`, `BLS_PRIVATE_KEY`, `BLS_PUBLIC_KEY`,
`SUI_NETWORK`, `BLACK_JACK_PACKAGE_ID`, `BLACK_JACK_GAME_MANAGER_ID`,
`CLIENT_ORIGIN` (default `http://localhost:3000`), `PORT` (default `3001`).

**`packages/client/.env`** (public, `VITE_` prefix):

```bash
cp packages/client/.env.example packages/client/.env
```
Fill the `VITE_*` vars (rename each `NEXT_PUBLIC_X` from `../app/.env` to `VITE_X`).
Keep `VITE_API_URL="/api"` for local dev (the Vite dev server proxies `/api` → `:3001`).

## Database (Prisma)

A local Postgres is provided via Docker (`docker-compose.yaml` in this folder):

```bash
cd app-vite
docker compose up -d        # starts postgres on :5432 (user/pass/db = poc/poc/poc)
```
This matches the default `POSTGRES_PRISMA_URL` in `packages/server/.env`:
`postgresql://poc:poc@localhost:5432/poc?schema=public`. Data persists in the
`poc-db-data` named volume. Stop with `docker compose down` (add `-v` to wipe data).

Then set up the schema:

```bash
cd packages/server
bun run prisma:generate     # generate the client (no DB needed)
bun run prisma:migrate      # apply migrations to POSTGRES_PRISMA_URL
```

## Develop

From `app-vite/`:

```bash
bun run dev          # client (http://localhost:3000) + server (http://localhost:3001)
# or individually:
bun run dev:client
bun run dev:server
```

The Vite dev server proxies `/api/*` to the server, so client `axios` calls to
`${VITE_API_URL}/...` (= `/api/...`) reach `:3001` with no CORS issues in dev.

## Build & run (production)

```bash
bun run build        # builds the client SPA into packages/client/dist (static + PWA)
bun run start        # runs the Bun server (serve dist/ behind any static host / Nginx)
```

For production set `VITE_API_URL` to the deployed server origin (e.g.
`https://api.example.com/api`) before `bun run build`, and set the server's `CLIENT_ORIGIN`
to the deployed client origin (CORS).

## Verify

```bash
bun run --filter '*' typecheck            # typecheck all packages
bun test packages/server/src/router.test.ts   # server router unit tests
curl http://localhost:3001/api/health     # -> {"status":"OK"}
```

