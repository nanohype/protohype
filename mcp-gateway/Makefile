.PHONY: install bootstrap deploy verify dashboard-build dashboard-sync full-deploy test smoke env-export clean

STACK_NAME := McpGateway
REGION     := us-west-2

install:
	npm install
	cd dashboard && npm install

bootstrap:
	cdk bootstrap aws://$$(aws sts get-caller-identity --query Account --output text)/$(REGION)

deploy:
	npm run deploy

dashboard-build:
	@API_ENDPOINT=$${API_ENDPOINT:-$$(aws cloudformation describe-stacks --region $(REGION) --stack-name $(STACK_NAME) --query "Stacks[0].Outputs[?ExportName=='McpGateway-ApiEndpoint'].OutputValue" --output text)}; \
	 if [ -z "$$API_ENDPOINT" ]; then echo "Could not resolve API_ENDPOINT — stack deployed?"; exit 1; fi; \
	 cd dashboard && NEXT_PUBLIC_API_ENDPOINT=$$API_ENDPOINT npm run build

dashboard-sync:
	@STATIC_BUCKET=$$(aws cloudformation describe-stacks --region $(REGION) --stack-name $(STACK_NAME) --query "Stacks[0].Outputs[?ExportName=='McpGateway-StaticBucketName'].OutputValue" --output text); \
	API_ENDPOINT=$$(aws cloudformation describe-stacks --region $(REGION) --stack-name $(STACK_NAME) --query "Stacks[0].Outputs[?ExportName=='McpGateway-ApiEndpoint'].OutputValue" --output text); \
	aws s3 sync dashboard/out/ s3://$$STATIC_BUCKET/ --region $(REGION) --delete --cache-control "public,max-age=31536000,immutable" --exclude "*.html"; \
	aws s3 sync dashboard/out/ s3://$$STATIC_BUCKET/ --region $(REGION) --cache-control "no-cache,no-store,must-revalidate" --include "*.html"; \
	printf '{"apiEndpoint":"%s","region":"%s"}' "$$API_ENDPOINT" "$(REGION)" | \
	aws s3 cp - s3://$$STATIC_BUCKET/config.json --region $(REGION) --content-type application/json --cache-control "no-cache,no-store,must-revalidate"; \
	DISTRIBUTION_ID=$$(aws cloudformation describe-stacks --region $(REGION) --stack-name $(STACK_NAME) --query "Stacks[0].Outputs[?ExportName=='McpGateway-DistributionId'].OutputValue" --output text); \
	aws cloudfront create-invalidation --distribution-id $$DISTRIBUTION_ID --paths "/*" --region $(REGION) > /dev/null

full-deploy: deploy dashboard-build dashboard-sync
	@echo "Full deploy complete"
	@make verify

env:
	$(eval export API_ENDPOINT=$(shell aws cloudformation describe-stacks --stack-name $(STACK_NAME) --query "Stacks[0].Outputs[?ExportName=='McpGateway-ApiEndpoint'].OutputValue" --output text))
	$(eval export API_TOKEN=$(shell aws secretsmanager get-secret-value --secret-id /mcp-gateway/gateway-bearer-token --query SecretString --output text))
	@echo "API_ENDPOINT=$$API_ENDPOINT" && echo "API_TOKEN=<set>"

verify:
	@API_ENDPOINT=$$(aws cloudformation describe-stacks --stack-name $(STACK_NAME) --query "Stacks[0].Outputs[?ExportName=='McpGateway-ApiEndpoint'].OutputValue" --output text); \
	API_TOKEN=$$(aws secretsmanager get-secret-value --secret-id /mcp-gateway/gateway-bearer-token --query SecretString --output text); \
	echo "Health check..." && curl -sf $$API_ENDPOINT/health | python3 -m json.tool; \
	echo "Memory tools/list..." && curl -sf -H "Authorization: Bearer $$API_TOKEN" -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","method":"tools/list","id":1}' $$API_ENDPOINT/memory | python3 -m json.tool; \
	echo "Auth check (expect 401)..." && STATUS=$$(curl -o /dev/null -w "%{http_code}" -s -H "Content-Type: application/json" -d '{"method":"tools/list"}' $$API_ENDPOINT/memory); [ "$$STATUS" = "401" ] && echo "401 OK" || echo "FAIL: Expected 401, got $$STATUS"

test:
	npm test

smoke:
	@API_ENDPOINT=$$(aws cloudformation describe-stacks --region $(REGION) --stack-name $(STACK_NAME) --query "Stacks[0].Outputs[?ExportName=='McpGateway-ApiEndpoint'].OutputValue" --output text) \
	 API_TOKEN=$$(aws secretsmanager get-secret-value --region $(REGION) --secret-id /mcp-gateway/gateway-bearer-token --query SecretString --output text) \
	 DASHBOARD_URL=$$(aws cloudformation describe-stacks --region $(REGION) --stack-name $(STACK_NAME) --query "Stacks[0].Outputs[?ExportName=='McpGateway-DashboardUrl'].OutputValue" --output text) \
	 npm run smoke

env-export:
	@echo "export API_ENDPOINT=$$(aws cloudformation describe-stacks --region $(REGION) --stack-name $(STACK_NAME) --query \"Stacks[0].Outputs[?ExportName=='McpGateway-ApiEndpoint'].OutputValue\" --output text)"
	@echo "export API_TOKEN=$$(aws secretsmanager get-secret-value --region $(REGION) --secret-id /mcp-gateway/gateway-bearer-token --query SecretString --output text)"
	@echo "export DASHBOARD_URL=$$(aws cloudformation describe-stacks --region $(REGION) --stack-name $(STACK_NAME) --query \"Stacks[0].Outputs[?ExportName=='McpGateway-DashboardUrl'].OutputValue\" --output text)"

clean:
	rm -rf dist node_modules dashboard/node_modules dashboard/out dashboard/.next
