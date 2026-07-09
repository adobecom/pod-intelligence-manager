/**
 * PimEc2Stack — MVP deployment stack (Path A: EC2 + SQLite + ALB + CloudFront).
 *
 * One EC2 instance runs the Fastify server container. SQLite lives on an
 * attached EBS volume mounted at /data. ALB fronts the instance; CloudFront
 * fronts the ALB for API/WS and an S3 bucket for the UI. Secrets come from
 * SSM Parameter Store at /pim/*. Backups mirror to S3 via a cron on the host.
 *
 * Not multi-AZ, not zero-downtime, not IMS-authed. Chosen to ship fast; see
 * pim-stack.ts for the eventual Lambda+DynamoDB design.
 */

import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as autoscaling from "aws-cdk-lib/aws-autoscaling";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as logs from "aws-cdk-lib/aws-logs";

export interface PimEc2StackProps extends cdk.StackProps {
  /** Owner namespace prefix for all named resources (bucket/repo/log group). */
  readonly owner: string;
  readonly instanceType?: ec2.InstanceType;
}

export class PimEc2Stack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: PimEc2StackProps) {
    super(scope, id, props);

    const owner = props.owner;
    const instanceType =
      props.instanceType ?? ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MEDIUM);

    // ──────────────────────────────────────
    // Network — minimal isolated VPC, public subnets only, no NAT ($0/mo)
    // ──────────────────────────────────────

    const vpc = new ec2.Vpc(this, "Vpc", {
      vpcName: `pim-${owner}-vpc`,
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        {
          name: "public",
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
      ],
    });

    // ──────────────────────────────────────
    // S3 buckets
    // ──────────────────────────────────────

    const uiBucket = new s3.Bucket(this, "UiBucket", {
      bucketName: `pim-${owner}-ui-${this.account}`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
    });

    const kgBucket = new s3.Bucket(this, "KnowledgeGraphBucket", {
      bucketName: `pim-${owner}-kg-${this.account}`,
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      lifecycleRules: [
        {
          id: "expire-old-noncurrent-versions",
          noncurrentVersionExpiration: cdk.Duration.days(30),
        },
      ],
    });

    const backupsBucket = new s3.Bucket(this, "BackupsBucket", {
      bucketName: `pim-${owner}-backups-${this.account}`,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      lifecycleRules: [
        {
          id: "ia-then-expire",
          transitions: [
            {
              // STANDARD_IA requires a minimum 30-day transition (AWS enforces)
              storageClass: s3.StorageClass.INFREQUENT_ACCESS,
              transitionAfter: cdk.Duration.days(30),
            },
          ],
          expiration: cdk.Duration.days(90),
        },
      ],
    });

    // ──────────────────────────────────────
    // ECR repo for the server image
    // ──────────────────────────────────────

    const ecrRepo = new ecr.Repository(this, "ServerRepo", {
      repositoryName: `pim-${owner}-server`,
      imageScanOnPush: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [{ description: "Keep last 10 images", maxImageCount: 10 }],
    });

    // ──────────────────────────────────────
    // CloudWatch log group (container logs ship here via awslogs driver)
    // ──────────────────────────────────────

    const logGroup = new logs.LogGroup(this, "ServerLogGroup", {
      logGroupName: `/aws/ec2/pim-${owner}-server`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ──────────────────────────────────────
    // Security groups
    // ──────────────────────────────────────

    const albSg = new ec2.SecurityGroup(this, "AlbSg", {
      vpc,
      description: "ALB ingress: HTTP/80 from CloudFront origin-facing prefix list only",
      allowAllOutbound: true,
    });
    // Allow only CloudFront's origin-facing IPs (region-specific managed prefix list).
    // Using 0.0.0.0/0 here trips Adobe's ELB-quarantine auto-remediation.
    // us-west-2: pl-82a045eb | us-east-1: pl-3b927c52
    const cloudfrontPrefixListId = this.region === "us-east-1" ? "pl-3b927c52" : "pl-82a045eb";
    albSg.addIngressRule(
      ec2.Peer.prefixList(cloudfrontPrefixListId),
      ec2.Port.tcp(80),
      "CloudFront origin-facing IPs",
    );

    const ec2Sg = new ec2.SecurityGroup(this, "Ec2Sg", {
      vpc,
      description: "EC2 ingress: Fastify on 4000 from ALB only",
      allowAllOutbound: true,
    });
    ec2Sg.addIngressRule(albSg, ec2.Port.tcp(4000), "Fastify from ALB");

    // ──────────────────────────────────────
    // IAM role for the EC2 instance
    // ──────────────────────────────────────

    const ec2Role = new iam.Role(this, "Ec2Role", {
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonSSMManagedInstanceCore"),
      ],
    });

    ec2Role.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "bedrock:InvokeModel",
          "bedrock:InvokeModelWithResponseStream",
          "bedrock:Converse",
          "bedrock:ConverseStream",
        ],
        resources: [
          `arn:aws:bedrock:${this.region}::foundation-model/anthropic.claude-*`,
          `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/us.anthropic.claude-*`,
          `arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-*`,
          `arn:aws:bedrock:us-east-1:${this.account}:inference-profile/us.anthropic.claude-*`,
          `arn:aws:bedrock:us-west-2::foundation-model/anthropic.claude-*`,
          `arn:aws:bedrock:us-west-2:${this.account}:inference-profile/us.anthropic.claude-*`,
        ],
      }),
    );

    kgBucket.grantReadWrite(ec2Role);
    // Read + write: cron uploads hourly backups here, and entrypoint.sh restores
    // the latest backup from here on a fresh instance (restore_db_if_empty).
    // Write-only would make restore-on-boot fail with AccessDenied on GetObject.
    backupsBucket.grantReadWrite(ec2Role);
    uiBucket.grantRead(ec2Role);
    logGroup.grantWrite(ec2Role);
    ecrRepo.grantPull(ec2Role);

    ec2Role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetParameter", "ssm:GetParameters", "ssm:GetParametersByPath"],
        resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/pim/*`],
      }),
    );

    // ──────────────────────────────────────
    // User data: install Docker, mount EBS, run container as systemd unit
    // ──────────────────────────────────────

    // Pin the server image by digest for deterministic rolls/rollback when provided
    // (`-c serverImageDigest=sha256:...`); otherwise track :latest. Build+push
    // first, capture the digest, then deploy pinned. See docs/EDR_SPLUNK_MIGRATION_PLAN.md.
    const serverImageDigest = this.node.tryGetContext("serverImageDigest") as
      | string
      | undefined;
    const containerImage = serverImageDigest
      ? `${ecrRepo.repositoryUri}@${serverImageDigest}`
      : `${ecrRepo.repositoryUri}:latest`;
    const awslogsGroup = logGroup.logGroupName;

    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      "set -eu",
      "dnf update -y",
      "dnf install -y docker cronie",
      "systemctl enable --now docker",
      "systemctl enable --now crond",

      // Security agents (CrowdStrike Falcon EDR + Splunk Universal Forwarder for
      // Security Splunk) are NOT installed here. The host boots from an Adobe Image
      // Factory AL2023 base image (see machineImage below) that bakes in and
      // auto-configures both: Falcon resolves the correct CID/tags from this AWS
      // account, and the Splunk UF is pre-configured via the Honeydew deployment
      // server. IF images are tested for EDR/Splunk/Hubble before release.
      // See docs/EDR_INSTALL_RUNBOOK.md.

      // Mount the secondary EBS volume at /data. Device name is /dev/sdb at attach
      // time but surfaces as /dev/nvme1n1 on Nitro instances. Detect either way.
      'DATA_DEV=""',
      "for CANDIDATE in /dev/nvme1n1 /dev/sdb /dev/xvdb; do",
      '  if [ -b "$CANDIDATE" ]; then DATA_DEV="$CANDIDATE"; break; fi',
      "done",
      'if [ -n "$DATA_DEV" ]; then',
      '  if ! blkid "$DATA_DEV" >/dev/null 2>&1; then',
      '    mkfs -t ext4 "$DATA_DEV"',
      "  fi",
      "  mkdir -p /data",
      '  echo "$DATA_DEV /data ext4 defaults,nofail 0 2" >> /etc/fstab',
      "  mount /data || true",
      "  mkdir -p /data/knowledge-graph",
      "fi",

      // ECR login
      `aws ecr get-login-password --region ${this.region} | docker login --username AWS --password-stdin ${this.account}.dkr.ecr.${this.region}.amazonaws.com`,
      `docker pull ${containerImage} || true`,

      // systemd unit for the server
      "cat > /etc/systemd/system/pim-server.service <<'UNIT_EOF'",
      "[Unit]",
      "Description=PIM Server",
      "Requires=docker.service",
      "After=docker.service",
      "",
      "[Service]",
      "Restart=always",
      "RestartSec=5",
      "TimeoutStopSec=30",
      "ExecStartPre=-/usr/bin/docker stop pim-server",
      "ExecStartPre=-/usr/bin/docker rm pim-server",
      `ExecStart=/usr/bin/docker run --rm --name pim-server -p 4000:4000 \\`,
      `  -v /data:/data \\`,
      `  -e PIM_SSM_PATH=/pim/ \\`,
      `  -e AWS_REGION=${this.region} \\`,
      `  -e KG_S3_BUCKET=${kgBucket.bucketName} \\`,
      `  -e KG_S3_PREFIX=knowledge-graph \\`,
      `  -e PIM_BACKUPS_BUCKET=${backupsBucket.bucketName} \\`,
      // Stateful host: refuse to start empty. entrypoint restore-db.sh restores the
      // DB from S3 on a fresh volume and fails closed if it can't (see that script).
      `  -e PIM_REQUIRE_RESTORE=true \\`,
      `  -e DB_PATH=/data/pim.db \\`,
      `  -e KG_DATA_DIR=/data/knowledge-graph \\`,
      `  -e CORS_ORIGIN=* \\`,
      `  --log-driver=awslogs \\`,
      `  --log-opt awslogs-region=${this.region} \\`,
      `  --log-opt awslogs-group=${awslogsGroup} \\`,
      `  --log-opt awslogs-create-group=true \\`,
      `  ${containerImage}`,
      "ExecStop=/usr/bin/docker stop pim-server",
      "",
      "[Install]",
      "WantedBy=multi-user.target",
      "UNIT_EOF",
      "systemctl daemon-reload",
      "systemctl enable --now pim-server",

      // Hourly SQLite backup via cron (runs inside the container where sqlite3 + aws-cli live)
      `cat > /etc/cron.d/pim-backup <<'CRON_EOF'`,
      `0 * * * * root /usr/bin/docker exec pim-server /app/packages/server/scripts/backup.sh >> /var/log/pim-backup.log 2>&1`,
      ``,
      `CRON_EOF`,
      "chmod 644 /etc/cron.d/pim-backup",
    );

    const launchTemplate = new ec2.LaunchTemplate(this, "ServerLaunchTemplate", {
      instanceType,
      // Adobe Image Factory AL2023 base image (flavor IF_Amazon-Linux-2023_aws),
      // which bakes in + auto-configures the required security agents: CrowdStrike
      // Falcon EDR (CID/tags resolved from this AWS account) and the Splunk
      // Universal Forwarder for Security Splunk. IF images are validated for
      // EDR/Splunk/Hubble before release, so no in-userData agent install is needed.
      //
      // Pinned to an exact AMI for a deterministic migration + rollback (previously
      // MachineImage.lookup, which re-resolves the newest match at synth time and is
      // nondeterministic). Bump deliberately after validating a newer IF release.
      // Only us-west-2 is mapped; add the prod region's shared AMI id before
      // deploying the production stack there. See docs/EDR_SPLUNK_MIGRATION_PLAN.md.
      machineImage: ec2.MachineImage.genericLinux({
        "us-west-2": "ami-06afdfc08e9b14b7e", // IF_Amazon-Linux-2023_aws_2.0.0, Falcon 7.23
      }),
      role: ec2Role,
      securityGroup: ec2Sg,
      userData,
      // Public subnet => need a public IP for outbound (ECR pull, Bedrock, S3, SSM) without a NAT gateway
      associatePublicIpAddress: true,
      blockDevices: [
        {
          deviceName: "/dev/xvda",
          volume: ec2.BlockDeviceVolume.ebs(20, {
            volumeType: ec2.EbsDeviceVolumeType.GP3,
            encrypted: true,
          }),
        },
        {
          deviceName: "/dev/sdb",
          volume: ec2.BlockDeviceVolume.ebs(30, {
            volumeType: ec2.EbsDeviceVolumeType.GP3,
            encrypted: true,
            deleteOnTermination: false,
          }),
        },
      ],
    });

    const asg = new autoscaling.AutoScalingGroup(this, "ServerAsg", {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      launchTemplate,
      minCapacity: 1,
      maxCapacity: 1,
      desiredCapacity: 1,
      healthCheck: autoscaling.HealthCheck.elb({ grace: cdk.Duration.minutes(5) }),
    });

    // ──────────────────────────────────────
    // Application Load Balancer
    // ──────────────────────────────────────

    const alb = new elbv2.ApplicationLoadBalancer(this, "ServerAlb", {
      vpc,
      internetFacing: true,
      securityGroup: albSg,
    });

    const targetGroup = new elbv2.ApplicationTargetGroup(this, "ServerTg", {
      vpc,
      port: 4000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.INSTANCE,
      healthCheck: {
        path: "/api/health",
        port: "4000",
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
      },
      deregistrationDelay: cdk.Duration.seconds(30),
    });

    asg.attachToApplicationTargetGroup(targetGroup);

    alb.addListener("HttpListener", {
      port: 80,
      defaultTargetGroups: [targetGroup],
      // Don't auto-add 0.0.0.0/0 ingress; we manage SG ingress explicitly above
      // via the CloudFront prefix list. The auto-added rule trips Adobe's
      // ELB-quarantine remediation.
      open: false,
    });

    // ──────────────────────────────────────
    // CloudFront distribution — UI from S3, API/WS from ALB
    // ──────────────────────────────────────

    const albOrigin = new origins.LoadBalancerV2Origin(alb, {
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
      httpPort: 80,
    });

    const apiBehavior: cloudfront.BehaviorOptions = {
      origin: albOrigin,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
      cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
      originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER,
    };

    const distribution = new cloudfront.Distribution(this, "PimCdn", {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(uiBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
      additionalBehaviors: {
        "/api/*": apiBehavior,
        "/ws": apiBehavior,
        "/ws/*": apiBehavior,
        // Tunnel proxy — forwards dev-preview traffic to the ALB. Matches
        // `/tunnel/{tunnelId}/{shareToken}[/*]` served by the Fastify server.
        "/tunnel/*": apiBehavior,
      },
      defaultRootObject: "index.html",
      errorResponses: [
        // SPA fallback: S3 with OAC returns 403 for any missing key; rewrite to index.html.
        // 404 is intentionally NOT rewritten so genuine API 404s pass through unchanged.
        { httpStatus: 403, responseHttpStatus: 200, responsePagePath: "/index.html" },
      ],
    });

    // ──────────────────────────────────────
    // Outputs
    // ──────────────────────────────────────

    new cdk.CfnOutput(this, "CloudFrontUrl", {
      value: `https://${distribution.distributionDomainName}`,
      description: "Public URL for the PIM UI + API",
    });
    new cdk.CfnOutput(this, "AlbDnsName", { value: alb.loadBalancerDnsName });
    new cdk.CfnOutput(this, "UiBucketName", { value: uiBucket.bucketName });
    new cdk.CfnOutput(this, "KnowledgeGraphBucketName", { value: kgBucket.bucketName });
    new cdk.CfnOutput(this, "BackupsBucketName", { value: backupsBucket.bucketName });
    new cdk.CfnOutput(this, "EcrRepoUri", { value: ecrRepo.repositoryUri });
    new cdk.CfnOutput(this, "AutoScalingGroupName", { value: asg.autoScalingGroupName });
    new cdk.CfnOutput(this, "LogGroupName", { value: logGroup.logGroupName });
    new cdk.CfnOutput(this, "DistributionId", { value: distribution.distributionId });
    new cdk.CfnOutput(this, "VpcId", { value: vpc.vpcId });
  }
}
