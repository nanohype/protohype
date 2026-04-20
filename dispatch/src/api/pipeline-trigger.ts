/**
 * PipelineTrigger — port + ECS implementation for ad-hoc, operator-driven
 * pipeline runs from the web admin UI. The scheduled EventBridge rule fires
 * the same task definition on its weekly cadence; this surface is for
 * "run it right now" requests outside that schedule.
 *
 * The port is narrow on purpose: the API server doesn't need to know about
 * subnet IDs, security groups, or task definition revisions — those are
 * configuration details the ECS implementation owns. Tests inject a fake
 * implementation that returns scripted task ARNs and statuses.
 */

import {
  ECSClient,
  RunTaskCommand,
  DescribeTasksCommand,
  type Task,
} from '@aws-sdk/client-ecs';

export interface PipelineTriggerResult {
  ecsTaskArn: string;
  startedAt: string;
}

export type PipelineTriggerStatus =
  | { state: 'running'; ecsTaskArn: string; startedAt: string }
  | { state: 'completed'; ecsTaskArn: string; startedAt: string; exitCode: number }
  | { state: 'failed'; ecsTaskArn: string; startedAt: string; exitCode: number | null; reason: string };

export interface PipelineTriggerPort {
  trigger(): Promise<PipelineTriggerResult>;
  status(ecsTaskArn: string): Promise<PipelineTriggerStatus>;
}

export interface EcsPipelineTriggerConfig {
  cluster: string;
  taskDefinitionFamily: string;
  subnetIds: string[];
  securityGroupId: string;
}

export function createEcsPipelineTrigger(
  config: EcsPipelineTriggerConfig,
  client: ECSClient = new ECSClient({}),
): PipelineTriggerPort {
  return {
    async trigger() {
      const result = await client.send(
        new RunTaskCommand({
          cluster: config.cluster,
          taskDefinition: config.taskDefinitionFamily, // family → latest active revision
          launchType: 'FARGATE',
          networkConfiguration: {
            awsvpcConfiguration: {
              subnets: config.subnetIds,
              securityGroups: [config.securityGroupId],
              assignPublicIp: 'DISABLED',
            },
          },
          // Tag the task so it's distinguishable in ECS console + CloudTrail
          // from EventBridge-scheduled runs.
          tags: [{ key: 'dispatch:trigger-source', value: 'admin-ui' }],
          enableECSManagedTags: true,
          propagateTags: 'TASK_DEFINITION',
        }),
      );
      const task = result.tasks?.[0];
      if (!task?.taskArn) {
        const failure = result.failures?.[0];
        throw new Error(
          `RunTask returned no task. Reason: ${failure?.reason ?? 'unknown'} (${failure?.detail ?? ''})`,
        );
      }
      return {
        ecsTaskArn: task.taskArn,
        startedAt: (task.createdAt ?? new Date()).toISOString(),
      };
    },

    async status(ecsTaskArn) {
      const result = await client.send(
        new DescribeTasksCommand({
          cluster: config.cluster,
          tasks: [ecsTaskArn],
        }),
      );
      const task: Task | undefined = result.tasks?.[0];
      if (!task) {
        throw new Error(`Task ${ecsTaskArn} not found in cluster ${config.cluster}`);
      }
      const startedAt = (task.createdAt ?? new Date()).toISOString();
      if (task.lastStatus !== 'STOPPED') {
        return { state: 'running', ecsTaskArn, startedAt };
      }
      const pipelineContainer = task.containers?.find((c) => c.name === 'pipeline');
      const exitCode = pipelineContainer?.exitCode ?? null;
      if (exitCode === 0) {
        return { state: 'completed', ecsTaskArn, startedAt, exitCode };
      }
      return {
        state: 'failed',
        ecsTaskArn,
        startedAt,
        exitCode,
        reason: pipelineContainer?.reason ?? task.stoppedReason ?? 'pipeline exited non-zero',
      };
    },
  };
}
