# Forge Desktop: everything an agent or a person runs. `make check` must pass before every commit lands.
.PHONY: build format format-check lint engine engine-fix identity preflight check hooks

build:         ## build build/app.noindex/Forge.app
	./build.sh
format:        ## rewrite Sources/ with the repo's swift-format rules
	xcrun swift-format format -i -r -p Sources
format-check:  ## fail if any Swift isn't formatted
	xcrun swift-format lint -r -s -p Sources
lint:          ## Forge Desktop's own rules + the debt list may only shrink
	python3 tools/lint/forge-lint.py
	tools/lint/check-baseline.sh
engine:        ## the engine's Biome check + layer-boundary tests
	tools/engine.sh pnpm install --frozen-lockfile --silent
	tools/engine.sh pnpm run check
engine-fix:    ## let Biome fix formatting and imports in engine/
	tools/engine.sh pnpm run fix
identity:      ## the next commit and every unmerged commit use the identity in .env, signed
	tools/check-identity.sh
	git fetch -q origin main 2>/dev/null || true
	tools/check-identity.sh --range origin/main..HEAD
preflight:     ## build + bundle + selftest + window + every lint rule proven to block
	tools/preflight.sh
check: identity format-check lint engine preflight   ## the whole gate
hooks:         ## once per clone: hooks on, and .env's identity into this clone's LOCAL git config
	@test -f .env || { echo "FIX: cp .env.example .env and fill it in first."; exit 1; }
	git config core.hooksPath .githooks
	@set -a; . ./.env; set +a; \
	git config --local user.name "$$GIT_AUTHOR_NAME"; \
	git config --local user.email "$$GIT_AUTHOR_EMAIL"; \
	git config --local user.signingkey "$$FORGE_GIT_SIGNING_KEY"; \
	git config --local gpg.format openpgp; \
	git config --local commit.gpgsign true; \
	git config --local tag.gpgsign true
	@echo "hooks on; this clone commits as the identity in .env, signed"
