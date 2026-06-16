# Top-level entry points for the two-package repo. The real commands live in
# sui_tunnel/ (Move) and sui-tunnel-ts/ (pnpm); these just wrap the cd-dance.

TS := sui-tunnel-ts
MV := sui_tunnel

.DEFAULT_GOAL := help
.PHONY: help install build test ci ts-install ts-build ts-typecheck ts-test \
        demo bench move-build move-test

help: ## Show this help
	@grep -hE '^[a-z-]+:.*?## ' $(MAKEFILE_LIST) | sort | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

install: ts-install ## Install all dependencies

build: move-build ts-build ## Build Move + TS

test: move-test ts-test ## Run all tests

ci: ts-typecheck test ## Run what CI runs

ts-install: ## Install TS SDK deps (pnpm)
	cd $(TS) && pnpm install

ts-build: ## Build the TS SDK
	cd $(TS) && pnpm build

ts-typecheck: ## Typecheck the TS SDK
	cd $(TS) && pnpm typecheck

ts-test: ## Run TS SDK tests
	cd $(TS) && pnpm test

demo: ## Run the end-to-end off-chain demo (no chain needed)
	cd $(TS) && node --import tsx src/examples/offchainDemo.ts

bench: ## Run the throughput benchmark harness
	cd $(TS) && node --import tsx src/bench/cli.ts --agents 200 --tunnels 1000 --updates-per-tunnel 300

move-build: ## Build the Move framework
	cd $(MV) && sui move build

move-test: ## Test the Move framework
	cd $(MV) && sui move test
