# Fluent Bit sidecar for Almanac.
# Receives app stdout via ECS FireLens forward protocol (auto-wired by Fargate
# when the app container's log driver is "awsfirelens"), extracts labels from
# the structured JSON, and ships to Grafana Cloud Loki via the built-in loki
# output plugin. Auth (LOKI_USERNAME + LOKI_API_TOKEN) is injected as secrets
# by the ECS task definition.

FROM public.ecr.aws/aws-observability/aws-for-fluent-bit:stable

COPY fluent-bit.conf /fluent-bit/etc/fluent-bit.conf
COPY parsers.conf    /fluent-bit/etc/parsers.conf
