// Alarms + dashboard. SNS → Slack wiring is an operational task (subscribe
// the topic from the notifications workspace); we only create the topic.

import { Duration } from "aws-cdk-lib";
import { Alarm, ComparisonOperator, Metric, TreatMissingData } from "aws-cdk-lib/aws-cloudwatch";
import { SnsAction } from "aws-cdk-lib/aws-cloudwatch-actions";
import { Topic } from "aws-cdk-lib/aws-sns";
import { Construct } from "constructs";
import type { StorageConstruct } from "./storage-construct.js";

export interface ObservabilityConstructProps {
  storage: StorageConstruct;
}

export class ObservabilityConstruct extends Construct {
  public readonly alarmTopic: Topic;

  constructor(scope: Construct, id: string, props: ObservabilityConstructProps) {
    super(scope, id);

    this.alarmTopic = new Topic(this, "AlarmTopic", {
      topicName: "kiln-alarms",
      displayName: "kiln operational alarms",
    });

    const dlqDepth = new Alarm(this, "UpgradeDlqDepthAlarm", {
      alarmName: "kiln-upgrade-dlq-depth",
      metric: props.storage.upgradeDlq.metricApproximateNumberOfMessagesVisible({
        period: Duration.minutes(5),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
      alarmDescription: "Any message in the upgrade DLQ means a job failed 3× — investigate",
    });
    dlqDepth.addAlarmAction(new SnsAction(this.alarmTopic));

    // Config rule compliance — paired with BedrockConstruct.
    const bedrockLoggingCompliance = new Alarm(this, "BedrockLoggingDriftAlarm", {
      alarmName: "kiln-bedrock-logging-drift",
      metric: new Metric({
        namespace: "AWS/Config",
        metricName: "ComplianceByConfigRule",
        dimensionsMap: {
          ConfigRuleName: "kiln-bedrock-inference-logging-disabled",
          ComplianceType: "NON_COMPLIANT",
        },
        period: Duration.minutes(5),
        statistic: "Maximum",
      }),
      threshold: 0,
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
      alarmDescription: "Bedrock inference logging has been re-enabled — customer code may leak to logs",
    });
    bedrockLoggingCompliance.addAlarmAction(new SnsAction(this.alarmTopic));
  }
}
