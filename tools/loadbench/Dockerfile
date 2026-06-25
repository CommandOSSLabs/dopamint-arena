# Build context: repo root (all three source trees are present).
#
# Dependency resolution strategy: install deps in-image for each tree that
# owns its own node_modules.  The root .dockerignore already excludes
# **/node_modules/ from the build context, so we COPY package.json files
# first and run `bun install` in each subtree that has external deps:
#   - sui-tunnel-ts          (@mysten/sui, @noble/*, dotenv)
#   - frontend/src/games/ticTacToe/packages/shared  (@mysten/bcs, @noble/*)
#   - tools/loadbench        (@mysten/sui)
#
# All COPY paths below are relative to the build context (repo root); all
# destination paths are absolute to avoid misplacement when WORKDIR changes.
#
# Frontend game source included:
#   - frontend/src/agent            — game kits and bots
#   - frontend/src/games/battleship — battleship kit imports protocol + engine
#   - frontend/src/games/blackjack/app/lib — blackjack kit imports bjBetProtocol
#   - frontend/src/games/ticTacToe/packages/shared — @ttt/shared with its deps
# Other games (bombIt, chickenCross, quantumPoker) only import sui-tunnel-ts
# and frontend/src/agent internals — no additional game source needed.

FROM oven/bun:1
WORKDIR /app

# ── sui-tunnel-ts ─────────────────────────────────────────────────────────────
COPY sui-tunnel-ts/package.json /app/sui-tunnel-ts/package.json
RUN cd /app/sui-tunnel-ts && bun install
COPY sui-tunnel-ts/src /app/sui-tunnel-ts/src

# ── @ttt/shared (ticTacToe kit dep) ───────────────────────────────────────────
COPY frontend/src/games/ticTacToe/packages/shared/package.json \
     /app/frontend/src/games/ticTacToe/packages/shared/package.json
# bun resolves the `file:../../../../../../sui-tunnel-ts` dep from the
# package.json location, which maps to /app/sui-tunnel-ts — already present.
RUN cd /app/frontend/src/games/ticTacToe/packages/shared && bun install
COPY frontend/src/games/ticTacToe/packages/shared/src \
     /app/frontend/src/games/ticTacToe/packages/shared/src
COPY frontend/src/games/ticTacToe/packages/shared/tsconfig.json \
     /app/frontend/src/games/ticTacToe/packages/shared/tsconfig.json

# ── game source files needed by agent kits ────────────────────────────────────
# battleship: kit imports protocol + engine directly via @/ alias
COPY frontend/src/games/battleship/protocol /app/frontend/src/games/battleship/protocol
COPY frontend/src/games/battleship/engine /app/frontend/src/games/battleship/engine
# blackjack: kit imports bjBetProtocol and bjCards via @/ alias
COPY frontend/src/games/blackjack/app/lib /app/frontend/src/games/blackjack/app/lib

# ── frontend agent kits (no extra npm deps beyond sui-tunnel-ts + @ttt/shared) ─
# tsconfig.json must be present so bun resolves `sui-tunnel-ts`, `@ttt/shared`,
# and `@/*` path aliases when it encounters files under frontend/src/.
COPY frontend/tsconfig.json /app/frontend/tsconfig.json
COPY frontend/src/agent /app/frontend/src/agent
COPY frontend/package.json /app/frontend/package.json

# ── loadbench ─────────────────────────────────────────────────────────────────
COPY tools/loadbench/package.json /app/tools/loadbench/package.json
COPY tools/loadbench/tsconfig.json /app/tools/loadbench/tsconfig.json
RUN cd /app/tools/loadbench && bun install
COPY tools/loadbench/src /app/tools/loadbench/src

WORKDIR /app/tools/loadbench
ENTRYPOINT ["bun", "run", "src/swarm.ts"]
