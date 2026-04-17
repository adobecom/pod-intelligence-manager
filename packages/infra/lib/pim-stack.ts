import * as cdk from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as apigatewayv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import { Construct } from "constructs";

export class PimStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ──────────────────────────────────────
    // DynamoDB Tables
    // ──────────────────────────────────────

    const podsTable = new dynamodb.Table(this, "PodsTable", {
      tableName: "pim-pods",
      partitionKey: { name: "pod_id", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const contextUpdatesTable = new dynamodb.Table(this, "ContextUpdatesTable", {
      tableName: "pim-context-updates",
      partitionKey: { name: "id", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    contextUpdatesTable.addGlobalSecondaryIndex({
      indexName: "pod-timestamp-index",
      partitionKey: { name: "pod_id", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "timestamp", type: dynamodb.AttributeType.STRING },
    });

    const conflictsTable = new dynamodb.Table(this, "ConflictsTable", {
      tableName: "pim-conflicts",
      partitionKey: { name: "id", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    conflictsTable.addGlobalSecondaryIndex({
      indexName: "pod-status-index",
      partitionKey: { name: "pod_id", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "status", type: dynamodb.AttributeType.STRING },
    });

    const knowledgeNodesTable = new dynamodb.Table(this, "KnowledgeNodesTable", {
      tableName: "pim-knowledge-nodes",
      partitionKey: { name: "id", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    knowledgeNodesTable.addGlobalSecondaryIndex({
      indexName: "type-confidence-index",
      partitionKey: { name: "type", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "confidence_score", type: dynamodb.AttributeType.NUMBER },
    });

    const livingDocsTable = new dynamodb.Table(this, "LivingDocsTable", {
      tableName: "pim-living-docs",
      partitionKey: { name: "pod_id", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const tunnelsTable = new dynamodb.Table(this, "TunnelsTable", {
      tableName: "pim-tunnels",
      partitionKey: { name: "tunnel_id", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    tunnelsTable.addGlobalSecondaryIndex({
      indexName: "pod-index",
      partitionKey: { name: "pod_id", type: dynamodb.AttributeType.STRING },
    });

    const orgSummariesTable = new dynamodb.Table(this, "OrgSummariesTable", {
      tableName: "pim-org-summaries",
      partitionKey: { name: "pod_id", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ──────────────────────────────────────
    // S3 Buckets
    // ──────────────────────────────────────

    const livingDocsBucket = new s3.Bucket(this, "LivingDocsBucket", {
      bucketName: `pim-living-docs-${this.account}`,
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      encryption: s3.BucketEncryption.S3_MANAGED,
    });

    const knowledgeGraphBucket = new s3.Bucket(this, "KnowledgeGraphBucket", {
      bucketName: `pim-knowledge-graph-${this.account}`,
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      encryption: s3.BucketEncryption.S3_MANAGED,
    });

    const uiBucket = new s3.Bucket(this, "UIBucket", {
      bucketName: `pim-ui-${this.account}`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    });

    // ──────────────────────────────────────
    // Lambda Functions
    // ──────────────────────────────────────

    const commonEnv = {
      PODS_TABLE: podsTable.tableName,
      CONTEXT_UPDATES_TABLE: contextUpdatesTable.tableName,
      CONFLICTS_TABLE: conflictsTable.tableName,
      KNOWLEDGE_NODES_TABLE: knowledgeNodesTable.tableName,
      LIVING_DOCS_TABLE: livingDocsTable.tableName,
      TUNNELS_TABLE: tunnelsTable.tableName,
      ORG_SUMMARIES_TABLE: orgSummariesTable.tableName,
      LIVING_DOCS_BUCKET: livingDocsBucket.bucketName,
      KNOWLEDGE_GRAPH_BUCKET: knowledgeGraphBucket.bucketName,
    };

    const apiLambda = new lambda.Function(this, "ApiFunction", {
      functionName: "pim-api",
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "index.handler",
      code: lambda.Code.fromAsset("../server/dist"),
      memorySize: 512,
      timeout: cdk.Duration.seconds(30),
      environment: commonEnv,
    });

    const ingestionLambda = new lambda.Function(this, "IngestionFunction", {
      functionName: "pim-ingestion",
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "ingestion.handler",
      code: lambda.Code.fromAsset("../server/dist"),
      memorySize: 512,
      timeout: cdk.Duration.seconds(60),
      environment: commonEnv,
    });

    const pimBrainLambda = new lambda.Function(this, "PimBrainFunction", {
      functionName: "pim-brain",
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "pim.handler",
      code: lambda.Code.fromAsset("../server/dist"),
      memorySize: 1024,
      timeout: cdk.Duration.seconds(120),
      environment: commonEnv,
    });

    const wsLambda = new lambda.Function(this, "WebSocketFunction", {
      functionName: "pim-ws",
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "ws.handler",
      code: lambda.Code.fromAsset("../server/dist"),
      memorySize: 256,
      timeout: cdk.Duration.seconds(30),
      environment: commonEnv,
    });

    const escalationLambda = new lambda.Function(this, "EscalationFunction", {
      functionName: "pim-escalation",
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "escalation.handler",
      code: lambda.Code.fromAsset("../server/dist"),
      memorySize: 256,
      timeout: cdk.Duration.seconds(60),
      environment: commonEnv,
    });

    const lintLambda = new lambda.Function(this, "LintFunction", {
      functionName: "pim-lint",
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "lint.handler",
      code: lambda.Code.fromAsset("../server/dist"),
      memorySize: 256,
      timeout: cdk.Duration.seconds(120),
      environment: commonEnv,
    });

    // Grant DynamoDB access to all Lambdas
    const allTables = [podsTable, contextUpdatesTable, conflictsTable, knowledgeNodesTable, livingDocsTable, tunnelsTable, orgSummariesTable];
    const allLambdas = [apiLambda, ingestionLambda, pimBrainLambda, wsLambda, escalationLambda, lintLambda];
    for (const table of allTables) {
      for (const fn of allLambdas) {
        table.grantReadWriteData(fn);
      }
    }

    // Grant S3 access
    livingDocsBucket.grantReadWrite(apiLambda);
    livingDocsBucket.grantReadWrite(pimBrainLambda);
    knowledgeGraphBucket.grantReadWrite(pimBrainLambda);

    // ──────────────────────────────────────
    // REST API Gateway
    // ──────────────────────────────────────

    const restApi = new apigateway.RestApi(this, "PimRestApi", {
      restApiName: "PIM API",
      deployOptions: { stageName: "v1" },
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
      },
    });

    // /api/pods
    const apiResource = restApi.root.addResource("api");
    const podsResource = apiResource.addResource("pods");
    podsResource.addMethod("POST", new apigateway.LambdaIntegration(apiLambda));

    const podResource = podsResource.addResource("{podId}");
    podResource.addMethod("GET", new apigateway.LambdaIntegration(apiLambda));

    // /api/pods/{podId}/context-updates
    const updatesResource = podResource.addResource("context-updates");
    updatesResource.addMethod("GET", new apigateway.LambdaIntegration(apiLambda));
    updatesResource.addMethod("POST", new apigateway.LambdaIntegration(ingestionLambda));

    // /api/pods/{podId}/conflicts
    const conflictsResource = podResource.addResource("conflicts");
    conflictsResource.addMethod("GET", new apigateway.LambdaIntegration(apiLambda));

    const conflictResource = conflictsResource.addResource("{conflictId}");
    conflictResource.addMethod("GET", new apigateway.LambdaIntegration(apiLambda));

    const resolveResource = conflictResource.addResource("resolve");
    resolveResource.addMethod("POST", new apigateway.LambdaIntegration(apiLambda));

    // /api/pods/{podId}/living-doc
    const livingDocResource = podResource.addResource("living-doc");
    livingDocResource.addMethod("GET", new apigateway.LambdaIntegration(apiLambda));

    // /api/knowledge
    const knowledgeResource = apiResource.addResource("knowledge");
    knowledgeResource.addResource("query").addMethod("POST", new apigateway.LambdaIntegration(apiLambda));
    knowledgeResource.addResource("relevant").addMethod("GET", new apigateway.LambdaIntegration(apiLambda));
    knowledgeResource.addResource("precedents").addMethod("GET", new apigateway.LambdaIntegration(apiLambda));

    // /api/health
    apiResource.addResource("health").addMethod("GET", new apigateway.LambdaIntegration(apiLambda));

    // ──────────────────────────────────────
    // WebSocket API Gateway
    // ──────────────────────────────────────

    const wsApi = new apigatewayv2.CfnApi(this, "PimWebSocketApi", {
      name: "PIM WebSocket",
      protocolType: "WEBSOCKET",
      routeSelectionExpression: "$request.body.action",
    });

    const wsIntegration = new apigatewayv2.CfnIntegration(this, "WsIntegration", {
      apiId: wsApi.ref,
      integrationType: "AWS_PROXY",
      integrationUri: `arn:aws:apigateway:${this.region}:lambda:path/2015-03-31/functions/${wsLambda.functionArn}/invocations`,
    });

    for (const route of ["$connect", "$disconnect", "$default"]) {
      new apigatewayv2.CfnRoute(this, `WsRoute${route.replace("$", "")}`, {
        apiId: wsApi.ref,
        routeKey: route,
        target: `integrations/${wsIntegration.ref}`,
      });
    }

    new apigatewayv2.CfnStage(this, "WsStage", {
      apiId: wsApi.ref,
      stageName: "v1",
      autoDeploy: true,
    });

    wsLambda.addPermission("WsApiPermission", {
      principal: new cdk.aws_iam.ServicePrincipal("apigateway.amazonaws.com"),
      sourceArn: `arn:aws:execute-api:${this.region}:${this.account}:${wsApi.ref}/*`,
    });

    // ──────────────────────────────────────
    // Scheduled Events (EventBridge)
    // ──────────────────────────────────────

    new events.Rule(this, "EscalationSchedule", {
      schedule: events.Schedule.rate(cdk.Duration.minutes(5)),
      targets: [new targets.LambdaFunction(escalationLambda)],
    });

    new events.Rule(this, "LintSchedule", {
      schedule: events.Schedule.rate(cdk.Duration.hours(2)),
      targets: [new targets.LambdaFunction(lintLambda)],
    });

    // ──────────────────────────────────────
    // CloudFront Distribution
    // ──────────────────────────────────────

    const distribution = new cloudfront.Distribution(this, "PimCDN", {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(uiBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      },
      additionalBehaviors: {
        "/api/*": {
          origin: new origins.RestApiOrigin(restApi),
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        },
      },
      defaultRootObject: "index.html",
      errorResponses: [
        { httpStatus: 404, responseHttpStatus: 200, responsePagePath: "/index.html" },
      ],
    });

    // ──────────────────────────────────────
    // Outputs
    // ──────────────────────────────────────

    new cdk.CfnOutput(this, "RestApiUrl", { value: restApi.url });
    new cdk.CfnOutput(this, "WebSocketUrl", {
      value: `wss://${wsApi.ref}.execute-api.${this.region}.amazonaws.com/v1`,
    });
    new cdk.CfnOutput(this, "CloudFrontUrl", { value: `https://${distribution.distributionDomainName}` });
    new cdk.CfnOutput(this, "UIBucketName", { value: uiBucket.bucketName });
  }
}
