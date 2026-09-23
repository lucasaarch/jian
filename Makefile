# Entry point of the repository. Every target delegates: pnpm owns the Node work, Docker
# owns the containers, Xcode owns the Apple side. Nothing is reimplemented here.
# `make` alone prints the list below, built from the `##` comment on each target, so the
# list cannot drift from the targets it describes.

IMAGE ?= ghcr.io/lucasaarch/jian-gateway
# The version `make release` writes, so a local image and a published one agree.
VERSION ?= $(shell node -p "require('./package.json').version")
REVISION ?= $(shell git rev-parse HEAD)

COMPOSE := docker compose -f compose.yaml
COMPOSE_DEV := docker compose -f compose.dev.yaml

.DEFAULT_GOAL := help

.PHONY: help install setup up down logs ps dev db-up db-stop db-reset \
        check test test-integration lint format build image image-push \
        changelog release \
        apple-test apple-lint apple-lint-fix apple-build apple-index

##@ General

help: ## List the targets
	@awk 'BEGIN { FS = ":.*?## " } \
		/^##@/ { printf "\n\033[1m%s\033[0m\n", substr($$0, 5) } \
		/^[a-zA-Z0-9_-]+:.*?## / { printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2 }' \
		$(MAKEFILE_LIST)
	@echo

##@ Setup

install: ## Install the workspace dependencies
	pnpm install --frozen-lockfile

setup: ## Write .env with local credentials, mode 0600, printing no secret
	pnpm run setup

##@ Production

up: ## Start the gateway and its database from compose.yaml
	$(COMPOSE) up -d --wait

down: ## Stop the production stack, keeping the volume
	$(COMPOSE) down

logs: ## Follow the production log
	$(COMPOSE) logs -f

ps: ## Show the state of the production containers
	$(COMPOSE) ps

##@ Development

dev: db-up ## Run the gateway on :4310 and the panel on :3000, both reloading
	pnpm run dev

db-up: ## Start the development PostgreSQL on 127.0.0.1:5432
	$(COMPOSE_DEV) up -d --wait postgres

db-stop: ## Stop the development PostgreSQL, keeping its data
	$(COMPOSE_DEV) stop postgres

db-migration: ## Write a migration for what changed in the schema file
	cd apps/gateway && pnpm exec drizzle-kit generate

db-reset: ## Delete the development database volume and start an empty one
	$(COMPOSE_DEV) down -v
	$(COMPOSE_DEV) up -d --wait postgres

##@ Quality

check: ## Lint, typecheck, unit tests, build and contract drift
	pnpm run check

test: ## Unit tests, no Docker and no provider
	pnpm run test

test-integration: ## Persistence tests; needs TEST_DATABASE_URL
	pnpm run test:integration

lint: ## Biome, warnings are errors
	pnpm run lint

format: ## Rewrite the formatting Biome expects
	pnpm run format

build: ## Compile the gateway and export the panel into it
	pnpm run build

##@ Image

image: ## Build the gateway image for this machine's architecture
	docker build \
		--build-arg JIAN_VERSION=$(VERSION) \
		--build-arg JIAN_REVISION=$(REVISION) \
		-t $(IMAGE):$(VERSION) .

image-push: ## Push the locally built image; the multi-architecture index comes from CI
	docker push $(IMAGE):$(VERSION)

##@ Release

changelog: ## Write CHANGELOG.md from the notes in docs/releases
	node scripts/changelog.mjs

# Releasing is a note and a tag; .github/workflows/image.yml builds both architectures and
# publishes the GitHub release with the note in it. The script refuses to tag a version with
# no note, a dirty tree, a main that is not on origin, or a tag that already exists.
release: ## Cut a release: write docs/releases/<v>.md, then `make release VERSION=1.2.3`
	@test "$(origin VERSION)" = "command line" || { echo "usage: make release VERSION=1.2.3"; exit 1; }
	node scripts/release.mjs $(VERSION)

##@ Apple

apple-test: ## JianKit unit tests
	cd apps/apple/Packages/JianKit && swift test

apple-lint: ## SwiftLint, strict
	cd apps/apple && swiftlint lint --quiet --strict

apple-lint-fix: ## Rewrite the violations SwiftLint can fix
	cd apps/apple && swiftlint lint --quiet --fix

apple-build: ## Build the Jian target for the iOS Simulator
	xcodebuild -project apps/apple/Jian.xcodeproj -scheme Jian \
		-destination 'generic/platform=iOS Simulator' -skipPackagePluginValidation build

apple-index: ## Refresh the sourcekit-lsp index so editors stop reporting phantom errors
	cd apps/apple && xcode-build-server config -project Jian.xcodeproj -scheme Jian \
		&& xcodebuild -project Jian.xcodeproj -scheme Jian -destination 'platform=macOS' \
			-skipPackagePluginValidation build | xcode-build-server parse -a
