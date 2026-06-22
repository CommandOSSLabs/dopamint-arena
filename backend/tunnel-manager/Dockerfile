# Build context MUST be the repo root: `-p tunnel-manager` needs the workspace
# Cargo.toml + Cargo.lock, which live at the root (not backend/tunnel-manager/).
# This image is built on an ARM64 runner to match the ECS Fargate ARM64 runtime.
FROM rust:1-bookworm AS builder
WORKDIR /app
# libpq-dev required: explorer's diesel/postgres feature links pq-sys at build time.
RUN apt-get update && apt-get install -y libpq-dev pkg-config && rm -rf /var/lib/apt/lists/*
COPY . .
RUN cargo build --release -p tunnel-manager -p explorer

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y ca-certificates curl libpq5 && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/target/release/tunnel-manager /usr/local/bin/tunnel-manager
COPY --from=builder /app/target/release/indexer /usr/local/bin/indexer
COPY --from=builder /app/target/release/api /usr/local/bin/api
EXPOSE 8080
# CMD (not ENTRYPOINT) so ECS container `command` can select indexer/api instead.
CMD ["/usr/local/bin/tunnel-manager"]
