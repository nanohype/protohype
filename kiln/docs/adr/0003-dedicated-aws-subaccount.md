# ADR 0003 — Dedicated AWS sub-account

## Status
Accepted (2026-04-20).

## Context
`CfnModelInvocationLoggingConfiguration` is account-wide in AWS Bedrock. kiln sends customer source code as part of its synthesis prompts — if logging is on, source code flows into CloudWatch or S3 and is retained per CloudWatch/S3 retention policies. This is unacceptable; kiln's security posture requires that customer source never leaves Bedrock's inference layer.

If kiln deployed to an AWS account shared with other workloads, one of those other workloads could enable Bedrock logging for its own purposes. Our drift alarm would catch it, but with minute-scale lag.

## Decision
kiln deploys to a dedicated `kiln` AWS sub-account. No other workload shares this account. The Bedrock inference-logging-off config is account-wide and an AWS Config rule alarms on drift.

## Consequences

- Bedrock logging cannot be accidentally re-enabled by neighbors.
- Separate AWS Organizations account; separate IAM policies; cleaner audit story.
- Operational cost: one more account to bill, monitor, patch. Tolerable.
- The sub-account must have Bedrock model access enabled in-console for Haiku 4.5, Sonnet 4.6, Opus 4.6 in `us-west-2` and `us-east-1` before first deploy.

## Alternatives considered
- **Shared account + SCP.** Service control policy denying `bedrock:PutModelInvocationLoggingConfiguration` would prevent drift, but requires AWS Org-level changes outside kiln's scope.
- **Accept the drift risk.** Bedrock logging being on for 5 minutes before the alarm fires means 5 minutes of potential source-code exposure. Not acceptable for SOC2-adjacent posture.
