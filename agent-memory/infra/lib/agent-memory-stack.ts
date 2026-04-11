/**
 * CDK Stack: agent-memory
 *
 * Provisions a single EC2 instance running agent-memory as a systemd service.
 *
 * Resources:
 *   - VPC (default or new) with public subnet
 *   - EC2 instance (Amazon Linux 2023, ARM64)
 *   - Security group (SSH + internal 8765)
 *   - EBS root volume (gp3)
 *   - IAM instance profile (SSM access for Session Manager)
 *   - User data script: clones repo, runs install.sh
 *
 * After deploy:
 *   - SSH: ssh -i <key> ec2-user@<public-ip>
 *   - Or use SSM: aws ssm start-session --target <instance-id>
 *   - Health: curl http://<public-ip>:8765/api/v1/health (only if SSH tunneled)
 */

import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

// ─── Stack Props ──────────────────────────────────────────────────────────────

export interface AgentMemoryStackProps extends cdk.StackProps {
  /** EC2 instance type (default: t3.micro) */
  instanceType?: string;
  /** EC2 key pair name for SSH access. Omit to use SSM Session Manager only. */
  sshKeyName?: string;
  /** CIDR allowed to SSH. Only used if sshKeyName is set. */
  sshAllowCidr?: string;
}

// ─── Stack ────────────────────────────────────────────────────────────────────

export class AgentMemoryStack extends cdk.Stack {
  public readonly instanceId: string;
  public readonly publicIp: string;

  constructor(scope: Construct, id: string, props: AgentMemoryStackProps = {}) {
    super(scope, id, props);

    const instanceTypeName = props.instanceType ?? 't3.micro';

    // ─── VPC ────────────────────────────────────────────────────────────

    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 1,
      natGateways: 0,
      subnetConfiguration: [
        {
          name: 'public',
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
      ],
    });

    // ─── Security Group ─────────────────────────────────────────────────

    const sg = new ec2.SecurityGroup(this, 'InstanceSg', {
      vpc,
      description: 'agent-memory instance',
      allowAllOutbound: true,
    });

    // SSH access (only if a key pair is provided)
    if (props.sshKeyName) {
      sg.addIngressRule(
        ec2.Peer.ipv4(props.sshAllowCidr ?? '0.0.0.0/0'),
        ec2.Port.tcp(22),
        'SSH access',
      );
    }

    // Port 8765 — internal only (same security group)
    // Agents on the same instance access via localhost.
    // For multi-instance setups, add a rule for the private subnet CIDR.
    sg.addIngressRule(
      sg,
      ec2.Port.tcp(8765),
      'agent-memory API (internal)',
    );

    // ─── IAM Role ───────────────────────────────────────────────────────

    const role = new iam.Role(this, 'InstanceRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      description: 'agent-memory EC2 instance role',
      managedPolicies: [
        // SSM Session Manager access (no SSH key needed)
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ],
    });

    // ─── User Data ──────────────────────────────────────────────────────

    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      '#!/bin/bash',
      'set -euo pipefail',
      '',
      '# Log everything to /var/log/agent-memory-setup.log',
      'exec > >(tee /var/log/agent-memory-setup.log) 2>&1',
      '',
      '# Install git',
      'dnf install -y git',
      '',
      '# Clone the repo',
      'cd /tmp',
      'git clone https://github.com/nanohype/protohype.git',
      'cd protohype/agent-memory',
      '',
      '# Run the installer',
      'bash deploy/install.sh',
      '',
      'echo "agent-memory setup complete at $(date)"',
    );

    // ─── EC2 Instance ───────────────────────────────────────────────────

    const instance = new ec2.Instance(this, 'Instance', {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      instanceType: new ec2.InstanceType(instanceTypeName),
      machineImage: ec2.MachineImage.latestAmazonLinux2023({
        cpuType: ec2.AmazonLinuxCpuType.X86_64,
      }),
      securityGroup: sg,
      role,
      userData,
      blockDevices: [
        {
          deviceName: '/dev/xvda',
          volume: ec2.BlockDeviceVolume.ebs(20, {
            volumeType: ec2.EbsDeviceVolumeType.GP3,
            encrypted: true,
          }),
        },
      ],
      ...(props.sshKeyName ? { keyName: props.sshKeyName } : {}),
    });

    // Tag for identification
    cdk.Tags.of(instance).add('Project', 'agent-memory');
    cdk.Tags.of(instance).add('ManagedBy', 'cdk');

    this.instanceId = instance.instanceId;
    this.publicIp = instance.instancePublicIp;

    // ─── Outputs ────────────────────────────────────────────────────────

    new cdk.CfnOutput(this, 'InstanceId', {
      value: instance.instanceId,
      description: 'EC2 instance ID',
    });

    new cdk.CfnOutput(this, 'PublicIp', {
      value: instance.instancePublicIp,
      description: 'Public IP (use SSH tunnel to access port 8765)',
    });

    new cdk.CfnOutput(this, 'SsmConnect', {
      value: `aws ssm start-session --target ${instance.instanceId}`,
      description: 'Connect via SSM Session Manager (no SSH key needed)',
    });

    new cdk.CfnOutput(this, 'SshTunnel', {
      value: props.sshKeyName
        ? `ssh -i <key>.pem -L 8765:localhost:8765 ec2-user@${instance.instancePublicIp}`
        : 'No SSH key configured — use SSM Session Manager',
      description: 'SSH tunnel command to access agent-memory locally',
    });

    new cdk.CfnOutput(this, 'HealthCheck', {
      value: 'curl http://localhost:8765/api/v1/health  # after SSH tunnel or SSM',
      description: 'Health check (run from instance or via tunnel)',
    });

    new cdk.CfnOutput(this, 'SetupLog', {
      value: `ssh ec2-user@${instance.instancePublicIp} "cat /var/log/agent-memory-setup.log"`,
      description: 'View the setup log to debug install issues',
    });
  }
}
