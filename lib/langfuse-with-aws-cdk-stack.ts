import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';

import { Construct } from 'constructs';
import { Web } from './constructs/services/web';
import { Worker } from './constructs/services/worker';
import { Database } from './constructs/database';
import { Cache } from './constructs/cache';
import { ClickHouse } from './constructs/services/clickhouse';
import { LOG_LEVEL, StackConfig, getStackConfig } from './stack-config';
import { Bastion } from './constructs/bastion';
import { Scheduler } from './constructs/scheduler';

export interface LangfuseWithAwsCdkStackProps extends cdk.StackProps {
  envName: string;
  hostName?: string;
  domainName?: string;
}

export class LangfuseWithAwsCdkStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: LangfuseWithAwsCdkStackProps) {
    super(scope, id, props);

    const { env, envName, hostName, domainName } = props;

    /**
     * Configurations
     */
    const stackConfig: StackConfig = getStackConfig(envName);

    const allowedIPv4Cidrs = stackConfig.allowedIPv4Cidrs ?? ['40.81.207.252/32']; // TODO Cognito対応完了次第、戻す
    // const allowedIPv6Cidrs = stackConfig.allowedIPv6Cidrs ?? ['::/0']; // TODO Cognito対応完了次第、戻す
    const langfuseImageTag = stackConfig.langfuseImageTag ?? 'latest';
    const clickhouseImageTag = stackConfig.clickhouseImageTag ?? 'latest';
    const langfuseLogLvel = stackConfig.langfuseLogLevel ?? LOG_LEVEL.INFO;

    /**
     * VPC
     */
    const vpc = new ec2.Vpc(this, 'VPC', {
      maxAzs: 2,
      subnetConfiguration: [
        {
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
        {
          name: 'Private',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask: 24,
        },
      ],
      ...(stackConfig.useNatIncetance
        ? {
            natGatewayProvider: ec2.NatProvider.instanceV2({
              instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.NANO),
              associatePublicIpAddress: true,
            }),
            natGateways: 1,
          }
        : undefined),
    });

    /**
     * ECS Cluster
     */
    const cluster = new ecs.Cluster(this, 'Cluster', {
      vpc,
      defaultCloudMapNamespace: {
        name: 'local',
        useForServiceConnect: true,
      },
      containerInsightsV2: ecs.ContainerInsights.ENABLED,
    });

    /**
     * S3 Bucket
     */
    const langfuseBucket = new s3.Bucket(this, 'Bucket', {
      autoDeleteObjects: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      enforceSSL: true,
    });

    /**
     * Database (PostgreSQL)
     */
    const database = new Database(this, 'Database', {
      vpc,
      auroraScalesToZero: stackConfig.auroraScalesToZero,
    });

    /**
     * Cache (Valkey)
     */
    const cache = new Cache(this, 'Cache', {
      vpc,
      cacheMultiAz: stackConfig.cacheMultiAz,
    });

    /**
     * Fargate Service (ClickHouse)
     */
    const clickhouse = new ClickHouse(this, 'ClickHouse', {
      vpc,
      cluster,
      enableFargateSpot: stackConfig.enableFargateSpot,
      taskDefCpu: stackConfig.taskDefCpu,
      taskDefMemoryLimitMiB: stackConfig.taskDefMemoryLimitMiB,
      imageTag: clickhouseImageTag,
    });

    /**
     * Encryption Key and Salt for Langfuse Services
     */
    const encryptionKey = new secretsmanager.Secret(this, 'EncryptionKey', {
      generateSecretString: {
        passwordLength: 64,
        excludeCharacters: 'ghijklmnopqrstuvwxyzGHIJKLMNOPQRSTUVWXYZ!@#$%^&*()_+=-[]{};:,.<>?/', // only 0-9, a-f used
        excludePunctuation: true,
        excludeUppercase: true,
        requireEachIncludedType: false,
      },
    });

    const salt = new secretsmanager.Secret(this, 'Salt', {
      generateSecretString: {
        passwordLength: 32,
        excludePunctuation: true,
      },
    });

    /**
     * Fargate Service (Langfuse Web)
     */
    const web = new Web(this, 'Web', {
      hostName: hostName,
      domainName: domainName,
      vpc,
      allowedIPv4Cidrs,
      // allowedIPv6Cidrs, // TODO Cognito対応完了次第、戻す
      cluster,
      enableFargateSpot: stackConfig.enableFargateSpot,
      taskDefCpu: stackConfig.taskDefCpu,
      taskDefMemoryLimitMiB: stackConfig.taskDefMemoryLimitMiB,
      langfuseWebTaskCount: stackConfig.langfuseWebTaskCount,
      imageTag: langfuseImageTag,
      logLevel: langfuseLogLvel,
      encryptionKey,
      salt,
      database,
      cache,
      clickhouse,
      bucket: langfuseBucket,
      env: env!,
    });

    /**
     * Fargate Service (Langfuse Worker)
     */
    const worker = new Worker(this, 'Worker', {
      cluster,
      enableFargateSpot: stackConfig.enableFargateSpot,
      taskDefCpu: stackConfig.taskDefCpu,
      taskDefMemoryLimitMiB: stackConfig.taskDefMemoryLimitMiB,
      imageTag: langfuseImageTag,
      logLevel: langfuseLogLvel,
      encryptionKey,
      salt,
      database,
      cache,
      clickhouse,
      bucket: langfuseBucket,
    });

    /**
     * Bastion
     */
    let bastion;
    if (stackConfig.createBastion) {
      bastion = new Bastion(this, 'Bastion', {
        vpc,
        database,
      });
    }

    new Scheduler(this, 'Scheduler', {
      env, 
      bastion, 
      clickhouse, 
      web, 
      worker
      }
    );

    /**
     * Outputs
     */
    new cdk.CfnOutput(this, 'LangfuseURL', {
      value: web.url,
      description: 'The URL of the Langfuse application',
      exportName: 'LangfuseURL',
    });
  }
}
