import * as iam from 'aws-cdk-lib/aws-iam';
import { CfnSchedule } from 'aws-cdk-lib/aws-scheduler';
import { Construct } from 'constructs';
import { Bastion } from './bastion';
import { ClickHouse } from './services/clickhouse';
import { Web } from './services/web';
import { Worker } from './services/worker';
import { Environment } from 'aws-cdk-lib';

export interface SchedulerProps {
  env?: Environment;
  bastion?: Bastion;
  clickhouse?: ClickHouse;
  web?: Web;
  worker?: Worker;
}

export class Scheduler extends Construct {
  constructor(scope: Construct, id: string, props: SchedulerProps) {
    super(scope, id);

    const { env, bastion, clickhouse, web, worker } = props;

    const schedulerRole = new iam.Role(this, 'SchedulerRole', {
      assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com'),
    });

    /***** 踏み台サーバの自動停止 *****/
    if (bastion) {
      schedulerRole.addToPolicy(
        new iam.PolicyStatement({
          actions: ['ec2:startInstances', 'ec2:stopInstances'],
          resources: [
            `arn:aws:ec2:${env!.region}:${env!.account}:instance/${bastion.host.instance.instance.ref}`
          ], // TODO ARN情報簡単に取得できないもんかな
        }),
      );

      // EC2インスタンスを停止するルールを作成
      new CfnSchedule(this, 'ScheduleEc2Stop', {
        description: 'Stop EC2 Instance',
        flexibleTimeWindow: { mode: 'OFF' },
        scheduleExpressionTimezone: 'Asia/Tokyo',
        scheduleExpression: 'cron(0 21 ? * MON-FRI *)',
        target: {
          arn: 'arn:aws:scheduler:::aws-sdk:ec2:stopInstances',
          input: JSON.stringify({ InstanceIds: [bastion.host.instanceId] }),
          roleArn: schedulerRole.roleArn,
        },
      });
    }
    
    if (clickhouse && web && worker) {
      for (const val of [clickhouse, web, worker]) {
        schedulerRole.addToPolicy(
          new iam.PolicyStatement({
            actions: ['ecs:UpdateService'],
            resources: [val.service.serviceArn],
          }),
        );
        new CfnSchedule(this, `ScheduleFargateStop${val.node.id}`, {
          description: 'Stop Faraget Task',
          flexibleTimeWindow: { mode: 'OFF' },
          scheduleExpressionTimezone: 'Asia/Tokyo',
          scheduleExpression: 'cron(0 21 ? * MON-FRI *)',
          target: {
            arn: 'arn:aws:scheduler:::aws-sdk:ecs:updateService',
            input: JSON.stringify({
              Service: val.service.serviceName,
              Cluster: val.service.cluster.clusterName,
              DesiredCount: 0,
            }),
            roleArn: schedulerRole.roleArn,
          },
        });

        new CfnSchedule(this, `ScheduleFargateStart${val.node.id}`, {
          description: 'Start Faraget Task',
          flexibleTimeWindow: { mode: 'OFF' },
          scheduleExpressionTimezone: 'Asia/Tokyo',
          scheduleExpression: 'cron(45 8 ? * MON-FRI *)',
          target: {
            arn: 'arn:aws:scheduler:::aws-sdk:ecs:updateService',
            input: JSON.stringify({
              Service: val.service.serviceName,
              Cluster: val.service.cluster.clusterName,
              DesiredCount: 1,
            }),
            roleArn: schedulerRole.roleArn,
          },
        });
      }
    }
  }
}
