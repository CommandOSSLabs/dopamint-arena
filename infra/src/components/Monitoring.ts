import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

export interface MonitoringArgs {
  name: string;
  albArnSuffix: pulumi.Input<string>;
  targetGroupArnSuffix: pulumi.Input<string>;
  clusterName: pulumi.Input<string>;
  serviceName: pulumi.Input<string>;
  dbClusterIdentifier: pulumi.Input<string>;
  logGroupName: pulumi.Input<string>;
}

export function createMonitoring(args: MonitoringArgs): void {
  new aws.cloudwatch.MetricAlarm(`${args.name}-alb-5xx`, {
    comparisonOperator: "GreaterThanThreshold",
    evaluationPeriods: 2,
    metricName: "HTTPCode_Target_5XX_Count",
    namespace: "AWS/ApplicationELB",
    statistic: "Sum",
    threshold: 10,
    period: 60,
    dimensions: {
      LoadBalancer: args.albArnSuffix,
    },
  });

  new aws.cloudwatch.MetricAlarm(`${args.name}-alb-latency`, {
    comparisonOperator: "GreaterThanThreshold",
    evaluationPeriods: 3,
    metricName: "TargetResponseTime",
    namespace: "AWS/ApplicationELB",
    extendedStatistic: "p99",
    threshold: 1,
    period: 60,
    dimensions: {
      LoadBalancer: args.albArnSuffix,
    },
  });

  new aws.cloudwatch.MetricAlarm(`${args.name}-ecs-cpu`, {
    comparisonOperator: "GreaterThanThreshold",
    evaluationPeriods: 3,
    metricName: "CPUUtilization",
    namespace: "AWS/ECS",
    statistic: "Average",
    threshold: 80,
    period: 60,
    dimensions: {
      ClusterName: args.clusterName,
      ServiceName: args.serviceName,
    },
  });

  new aws.cloudwatch.MetricAlarm(`${args.name}-ecs-memory`, {
    comparisonOperator: "GreaterThanThreshold",
    evaluationPeriods: 3,
    metricName: "MemoryUtilization",
    namespace: "AWS/ECS",
    statistic: "Average",
    threshold: 80,
    period: 60,
    dimensions: {
      ClusterName: args.clusterName,
      ServiceName: args.serviceName,
    },
  });

  new aws.cloudwatch.MetricAlarm(`${args.name}-db-cpu`, {
    comparisonOperator: "GreaterThanThreshold",
    evaluationPeriods: 3,
    metricName: "CPUUtilization",
    namespace: "AWS/RDS",
    statistic: "Average",
    threshold: 80,
    period: 60,
    dimensions: {
      DBClusterIdentifier: args.dbClusterIdentifier,
    },
  });

  new aws.cloudwatch.LogMetricFilter(`${args.name}-backend-errors`, {
    pattern: "{ $.level = \"error\" }",
    logGroupName: args.logGroupName,
    metricTransformation: {
      name: `${args.name}-error-count`,
      namespace: "Dopamint/Backend",
      value: "1",
      defaultValue: "0",
    },
  });
}
