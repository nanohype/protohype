/**
 * Custom resource handler: sets Bedrock invocation logging to NONE.
 * Called by CDK custom resource on every deploy.
 * Security requirement: enforced at deploy time, not just at inference call time.
 */

import { BedrockClient, PutModelInvocationLoggingConfigurationCommand } from '@aws-sdk/client-bedrock';
import type { CloudFormationCustomResourceEvent, CloudFormationCustomResourceResponse } from 'aws-lambda';

const bedrockClient = new BedrockClient({ region: process.env['AWS_REGION'] ?? 'us-west-2' });

export const handler = async (event: CloudFormationCustomResourceEvent): Promise<CloudFormationCustomResourceResponse> => {
  // PhysicalResourceId rules:
  // - CREATE: generate a stable ID so repeated deploys don't churn the resource.
  // - UPDATE / DELETE: preserve the ID CFN has on record. Returning a DIFFERENT
  //   ID than what was persisted on the previous CREATE causes CFN to reject
  //   the response with:
  //     "cannot change the physical resource ID from X to Y during deletion"
  //   which then prevents the stack rollback from completing. If CFN passes us
  //   a PhysicalResourceId (it will, for Update + Delete), always echo it back.
  const physicalResourceId =
    event.RequestType === 'Create' ? `bedrock-invocation-logging-none-${process.env['AWS_REGION']}` : event.PhysicalResourceId;
  const base = {
    PhysicalResourceId: physicalResourceId,
    StackId: event.StackId,
    RequestId: event.RequestId,
    LogicalResourceId: event.LogicalResourceId,
  };

  if (event.RequestType === 'Delete') {
    // Nothing to undo — the Bedrock account-level logging setting persists
    // across stack lifecycle. Return success with the preserved ID so CFN can
    // finalise the delete.
    return { Status: 'SUCCESS', ...base, Data: {} };
  }

  try {
    await bedrockClient.send(
      new PutModelInvocationLoggingConfigurationCommand({
        loggingConfig: {
          textDataDeliveryEnabled: false,
          imageDataDeliveryEnabled: false,
          embeddingDataDeliveryEnabled: false,
        },
      }),
    );
    return { Status: 'SUCCESS', ...base, Data: { Message: 'Bedrock invocation logging set to NONE', Region: process.env['AWS_REGION'] } };
  } catch (err) {
    return { Status: 'FAILED', ...base, Reason: err instanceof Error ? err.message : String(err), Data: {} };
  }
};
