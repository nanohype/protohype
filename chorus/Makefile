.PHONY: help install typecheck lint format format-check test build ci migrate clean cdk-synth cdk-diff cdk-deploy cdk-bootstrap eval ui-install ui-dev ui-build ui-typecheck ui-lint ui-format-check ui-ci ecr-login ecr-create docker-build ecr-push deploy

REGION   ?= us-east-1
STACK_NAME ?= ChorusStack
# Image tag — defaults to the short git SHA so each deploy is uniquely
# addressable. Override with `make deploy VERSION=v0.1.0` for releases.
VERSION  ?= $(shell git rev-parse --short HEAD 2>/dev/null || echo dev)
SERVICES := chorus-api chorus-worker chorus-digest

# AWS account is resolved on demand via STS so the Makefile doesn't
# leak any account ID into the repo.
account = $$(aws sts get-caller-identity --query Account --output text)
repo    = $(account).dkr.ecr.$(REGION).amazonaws.com

# chorus — operations entrypoint.
#
# Local dev:    install, typecheck, lint, format, test, build, ci, migrate
# Eval:         eval (requires DATABASE_URL + AWS creds + populated labeled set)
# Deploy:       cdk-bootstrap, cdk-synth, cdk-diff, cdk-deploy
#
# CDK targets pass image URIs through context — build & push the
# container images first, then `make cdk-deploy API_IMAGE_URI=... ...`.

help:
	@echo "chorus operations:"
	@echo "  make install        npm ci"
	@echo "  make typecheck      tsc --noEmit"
	@echo "  make lint           eslint src infra"
	@echo "  make format         prettier --write"
	@echo "  make format-check   prettier --check"
	@echo "  make test           vitest run"
	@echo "  make build          tsc -> dist/"
	@echo "  make ci             typecheck + lint + format-check + test + build"
	@echo "  make migrate        apply pending SQL migrations (requires DATABASE_URL)"
	@echo "  make eval           run matching-accuracy harness (requires DATABASE_URL + AWS)"
	@echo "  make cdk-bootstrap  cdk bootstrap (one-time per AWS account/region)"
	@echo "  make cdk-synth      cdk synth"
	@echo "  make cdk-diff       cdk diff against the deployed stack"
	@echo "  make cdk-deploy     cdk deploy (API_IMAGE_URI=... WORKER_IMAGE_URI=... DIGEST_IMAGE_URI=...)"
	@echo "  make ecr-login      docker login to ECR for the current AWS account"
	@echo "  make ecr-create     create the three ECR repositories (idempotent)"
	@echo "  make docker-build   build all 3 service images locally (VERSION=$(VERSION))"
	@echo "  make ecr-push       tag + push the 3 images to ECR (VERSION=$(VERSION))"
	@echo "  make deploy         one-command: build + push + cdk-deploy at VERSION=$(VERSION)"
	@echo "  make ui-install     npm ci in frontend/"
	@echo "  make ui-typecheck   tsc --noEmit in frontend/"
	@echo "  make ui-lint        eslint in frontend/"
	@echo "  make ui-format-check prettier --check in frontend/"
	@echo "  make ui-build       next build in frontend/"
	@echo "  make ui-dev         next dev -p 3001 in frontend/"
	@echo "  make ui-ci          ui-typecheck + ui-lint + ui-format-check + ui-build"
	@echo "  make clean          remove dist/, node_modules/, coverage/"

install:
	npm ci

typecheck:
	npm run typecheck

lint:
	npm run lint

format:
	npm run format

format-check:
	npm run format:check

test:
	npm test

build:
	npm run build

ci: typecheck lint format-check test build
	@echo "ci ✓"

migrate:
	@if [ -z "$$DATABASE_URL" ]; then \
		echo "DATABASE_URL is required (e.g. postgres://chorusapp:CHANGEME@localhost:5432/chorus)"; \
		exit 1; \
	fi
	npm run migrate

eval:
	@if [ -z "$$DATABASE_URL" ]; then echo "DATABASE_URL required"; exit 1; fi
	npx tsx evals/matching-accuracy-harness.ts

cdk-bootstrap:
	npx cdk bootstrap aws://$$(aws sts get-caller-identity --query Account --output text)/$(REGION)

cdk-synth:
	npm run cdk:synth

cdk-diff:
	npm run cdk:diff

cdk-deploy:
	@if [ -z "$$API_IMAGE_URI" ] || [ -z "$$WORKER_IMAGE_URI" ] || [ -z "$$DIGEST_IMAGE_URI" ]; then \
		echo "API_IMAGE_URI, WORKER_IMAGE_URI, DIGEST_IMAGE_URI all required (build & push images first, or use 'make deploy')"; \
		exit 1; \
	fi
	npm run cdk:deploy -- \
		-c apiImageUri=$$API_IMAGE_URI \
		-c workerImageUri=$$WORKER_IMAGE_URI \
		-c digestImageUri=$$DIGEST_IMAGE_URI

# ─── ECR + container build/push ────────────────────────────────────
# Tokens are NEVER baked into images. The container reads them from
# Secrets Manager at runtime via lib/secrets.ts; ops populates the
# secret values post-deploy with `aws secretsmanager put-secret-value`.

ecr-login:
	aws ecr get-login-password --region $(REGION) | \
		docker login --username AWS --password-stdin $(repo)

ecr-create:
	@for svc in $(SERVICES); do \
		aws ecr describe-repositories --repository-names $$svc --region $(REGION) >/dev/null 2>&1 || \
			aws ecr create-repository --repository-name $$svc --region $(REGION) \
				--image-scanning-configuration scanOnPush=true \
				--encryption-configuration encryptionType=AES256 >/dev/null; \
		echo "ecr repo ready: $$svc"; \
	done

docker-build:
	docker build --platform linux/amd64 -f Dockerfile.api    -t chorus-api:$(VERSION)    .
	docker build --platform linux/amd64 -f Dockerfile.worker -t chorus-worker:$(VERSION) .
	docker build --platform linux/amd64 -f Dockerfile.digest -t chorus-digest:$(VERSION) .

ecr-push: ecr-login ecr-create
	@for svc in $(SERVICES); do \
		docker tag $$svc:$(VERSION) $(repo)/$$svc:$(VERSION) && \
		docker tag $$svc:$(VERSION) $(repo)/$$svc:latest && \
		docker push $(repo)/$$svc:$(VERSION) && \
		docker push $(repo)/$$svc:latest; \
	done

deploy: docker-build ecr-push
	@$(MAKE) cdk-deploy \
		API_IMAGE_URI=$(repo)/chorus-api:$(VERSION) \
		WORKER_IMAGE_URI=$(repo)/chorus-worker:$(VERSION) \
		DIGEST_IMAGE_URI=$(repo)/chorus-digest:$(VERSION)

ui-install:
	cd frontend && npm ci

ui-typecheck:
	cd frontend && npm run typecheck

ui-lint:
	cd frontend && npm run lint

ui-format-check:
	cd frontend && npm run format:check

ui-build:
	cd frontend && npm run build

ui-dev:
	cd frontend && npm run dev

ui-ci: ui-typecheck ui-lint ui-format-check ui-build
	@echo "ui-ci ✓"

clean:
	rm -rf dist node_modules coverage cdk.out frontend/node_modules frontend/.next
