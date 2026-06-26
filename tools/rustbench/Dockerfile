# Multi-stage: compile the release binary, then ship a slim runtime.
FROM rust:1-bookworm AS build
WORKDIR /src
COPY . .
RUN cargo build -p rustbench --release

FROM debian:bookworm-slim
COPY --from=build /src/target/release/rustbench /usr/local/bin/rustbench
ENTRYPOINT ["rustbench"]
CMD ["--offchain", "--channel", "local", "--game", "blackjack"]
