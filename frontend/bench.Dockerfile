FROM oven/bun:1.3.5

# Install Node 24 and pnpm to match the host toolchain.
RUN apt-get update \
 && apt-get install -y curl ca-certificates \
 && curl -fsSL https://deb.nodesource.com/setup_26.x | bash - \
 && apt-get install -y nodejs \
 && npm install -g pnpm@11.6.0 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy dependency manifests first for layer caching.
COPY sui-tunnel-ts/package.json sui-tunnel-ts/pnpm-lock.yaml ./sui-tunnel-ts/
COPY frontend/package.json frontend/pnpm-lock.yaml ./frontend/

# Install dependencies in both packages. Ignore post-install scripts: the benchmark
# uses bun's own bundler, so esbuild's platform-specific binary is not required.
RUN cd sui-tunnel-ts && pnpm install --frozen-lockfile --ignore-scripts
RUN cd frontend && pnpm install --frozen-lockfile --ignore-scripts

# Copy the rest of the source.
COPY sui-tunnel-ts/ ./sui-tunnel-ts/
COPY frontend/ ./frontend/

WORKDIR /app/frontend

# Build the bench bundles.
RUN pnpm build:bench

# Run the full multi-game benchmark. Duration is controlled via BENCH_DURATION.
CMD ["bun", "dist/bench/solo-local.js"]
