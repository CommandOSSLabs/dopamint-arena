# Build context MUST be the repo root: `-p tunnel-manager` needs the workspace
# Cargo.toml + Cargo.lock, which live at the root (not backend/tunnel-manager/).
# This image is built on an ARM64 runner to match the ECS Fargate ARM64 runtime.
FROM rust:1-bookworm AS builder
WORKDIR /app
COPY . .
RUN cargo build --release -p tunnel-manager

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y ca-certificates curl && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/target/release/tunnel-manager /usr/local/bin/tunnel-manager
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/tunnel-manager"]
