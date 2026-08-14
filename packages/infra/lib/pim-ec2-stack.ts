/**
 * PimEc2Stack — MVP deployment stack (Path A: EC2 + SQLite + ALB + CloudFront).
 *
 * One EC2 instance runs the Fastify server container. SQLite lives on an
 * attached EBS volume mounted at /data. ALB fronts the instance; CloudFront
 * fronts the ALB for API/WS and an S3 bucket for the UI. Secrets come from
 * SSM Parameter Store at /pim/*. Portable core backups mirror to S3 via a cron;
 * AWS Backup takes incremental recovery points of the complete /data volume.
 *
 * Not multi-AZ or zero-downtime. The server supports trust and IMS auth modes;
 * hosted auth configuration is supplied through SSM. See pim-stack.ts for the
 * historical Lambda/DynamoDB target design.
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
import * as backup from "aws-cdk-lib/aws-backup";
import * as events from "aws-cdk-lib/aws-events";
import * as eventTargets from "aws-cdk-lib/aws-events-targets";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cloudwatchActions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as sns from "aws-cdk-lib/aws-sns";
import * as snsSubscriptions from "aws-cdk-lib/aws-sns-subscriptions";

export interface PimEc2StackProps extends cdk.StackProps {
  /** Owner namespace prefix for all named resources (bucket/repo/log group). */
  readonly owner: string;
  readonly instanceType?: ec2.InstanceType;
}

export class PimEc2Stack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: PimEc2StackProps) {
    super(scope, id, props);

    const owner = props.owner;
    const dataVolumeBackupTagKey = "PimBackup";
    const dataVolumeBackupTagValue = `pim-${owner}-data`;
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
          id: "expire-hourly-core-backups",
          prefix: "backups/hourly/",
          expiration: cdk.Duration.days(3),
        },
        {
          id: "expire-daily-core-backups",
          prefix: "backups/daily/",
          expiration: cdk.Duration.days(35),
        },
        {
          id: "archive-weekly-core-backups",
          prefix: "backups/weekly/",
          transitions: [
            {
              // STANDARD_IA requires a minimum 30-day transition (AWS enforces)
              storageClass: s3.StorageClass.INFREQUENT_ACCESS,
              transitionAfter: cdk.Duration.days(30),
            },
          ],
          expiration: cdk.Duration.days(91),
        },
        {
          // Preserve the retention policy for full dumps created by images that
          // predate tiered core backups. The prefix deliberately excludes the
          // new hourly/daily/weekly subdirectories.
          id: "archive-legacy-full-backups",
          prefix: "backups/pim-",
          transitions: [
            {
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

    // Canonical-memory cutover fence. The startup assert, the read-only
    // knowledge-graph mount, and the KG bucket write revocation must all land
    // strictly AFTER the offline cutover (`pnpm migrate-legacy-memory`) has
    // committed the canonical authority transition — deploying them first
    // crash-loops the server fail-closed and breaks still-live legacy graph
    // writes. Flip with `cdk deploy -c memoryCutoverComplete=true` once the
    // cutover has been verified; never as part of the same deploy.
    const cutoverContext: unknown = this.node.tryGetContext("memoryCutoverComplete");
    const memoryCutoverComplete = cutoverContext === true
      || (typeof cutoverContext === "string" && cutoverContext.trim() === "true");
    // Manual releases may build on the scoped PIM host when CI credentials are
    // unavailable. ECR push is then raised only through this stack and must be
    // lowered again in the digest-pinning deploy immediately after the push.
    // Normal synthesis and the GitHub workflow leave it disabled.
    const imagePushContext: unknown = this.node.tryGetContext("allowServerImagePush");
    const allowServerImagePush = imagePushContext === true
      || (typeof imagePushContext === "string" && imagePushContext.trim() === "true");

    const operationsAlerts = new sns.Topic(this, "OperationsAlerts", {
      topicName: `pim-${owner}-operations-alerts`,
      displayName: `PIM ${owner} operations alerts`,
    });
    const alarmEmail = this.node.tryGetContext("alarmEmail");
    if (typeof alarmEmail === "string" && alarmEmail.trim()) {
      operationsAlerts.addSubscription(
        new snsSubscriptions.EmailSubscription(alarmEmail.trim()),
      );
    }
    const operationsAlarmAction = new cloudwatchActions.SnsAction(operationsAlerts);
    const memoryMetric = (
      metricName: string,
      statistic = "Maximum",
      period = cdk.Duration.minutes(1),
      dimensionsMap?: Record<string, string>,
    ) => new cloudwatch.Metric({
      namespace: "PIM/Memory",
      metricName,
      statistic,
      period,
      ...(dimensionsMap ? { dimensionsMap } : {}),
    });
    const addOperationsAlarm = (
      id: string,
      props: cloudwatch.AlarmProps,
    ): cloudwatch.Alarm => {
      const alarm = new cloudwatch.Alarm(this, id, props);
      alarm.addAlarmAction(operationsAlarmAction);
      return alarm;
    };

    addOperationsAlarm("MemoryBoundaryLeakageAlarm", {
      alarmName: `pim-${owner}-memory-boundary-leakage`,
      alarmDescription: "P1: persisted memory crossed an org/project/plane/repository boundary",
      metric: memoryMetric("BoundaryLeakageCount"),
      threshold: 0,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    addOperationsAlarm("MemoryActivePointerAlarm", {
      alarmName: `pim-${owner}-memory-active-pointer-violation`,
      alarmDescription: "An active candidate does not resolve to its same-scope immutable record version",
      metric: memoryMetric("ActivePointerViolationCount"),
      threshold: 0,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    addOperationsAlarm("MemoryDeadLetterAlarm", {
      alarmName: `pim-${owner}-memory-dead-letter`,
      alarmDescription: "Memory outbox or provider-inbox work reached active dead letter",
      metric: memoryMetric("DeadLetterCount"),
      threshold: 0,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    addOperationsAlarm("MemoryOutboxAgeAlarm", {
      alarmName: `pim-${owner}-memory-outbox-overdue`,
      alarmDescription: "Oldest due or expired-lease memory job has waited more than five minutes",
      metric: memoryMetric("OldestOutboxAgeSeconds"),
      threshold: 300,
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    addOperationsAlarm("MemorySearchLatencyAlarm", {
      alarmName: `pim-${owner}-memory-search-p95-latency`,
      alarmDescription: "Codebase memory search p95 exceeded the 500 ms SLO",
      metric: memoryMetric(
        "SearchLatency",
        "p95",
        cdk.Duration.minutes(5),
        { outcome: "success", plane: "codebase" },
      ),
      threshold: 500,
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    addOperationsAlarm("LogicalBackupHeartbeatAlarm", {
      alarmName: `pim-${owner}-logical-backup-heartbeat`,
      alarmDescription: "Hourly verified logical backup failed or did not publish its heartbeat",
      metric: new cloudwatch.Metric({
        namespace: "PIM/Backup",
        metricName: "LogicalBackupSuccess",
        dimensionsMap: { Deployment: owner },
        statistic: "Minimum",
        period: cdk.Duration.hours(1),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
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

    // The JSON knowledge graph becomes a read-only legacy projection once the
    // canonical memory cutover has run. Keep the infrastructure fence aligned
    // with the database authority state: write access stays until the cutover
    // is verified, then the post-cutover deploy revokes it so rollback cannot
    // revive the legacy write path.
    if (memoryCutoverComplete) {
      kgBucket.grantRead(ec2Role);
    } else {
      // Pre-cutover the server still write-through-mirrors graph saves to S3.
      kgBucket.grantReadWrite(ec2Role);
    }
    // Read + write: cron uploads hourly backups, while bootstrap restores exact
    // checksummed DB/KG/manifest keys from one pinned recovery generation.
    backupsBucket.grantReadWrite(ec2Role);
    ec2Role.addToPolicy(new iam.PolicyStatement({
      actions: ["cloudwatch:PutMetricData"],
      resources: ["*"],
      conditions: {
        StringEquals: { "cloudwatch:namespace": "PIM/Backup" },
      },
    }));
    uiBucket.grantRead(ec2Role);
    logGroup.grantWrite(ec2Role);
    if (allowServerImagePush) {
      ecrRepo.grantPullPush(ec2Role);
    } else {
      ecrRepo.grantPull(ec2Role);
    }

    ec2Role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetParameter", "ssm:GetParameters", "ssm:GetParametersByPath"],
        resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/pim/*`],
      }),
    );

    // LaunchTemplate's L2 block-device API cannot tag only one of its EBS
    // volumes. User data resolves /dev/sdb and applies this constrained tag so
    // AWS Backup snapshots the stateful data disk, not the disposable root disk.
    ec2Role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["ec2:DescribeVolumes"],
        resources: ["*"],
      }),
    );
    ec2Role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["ec2:CreateTags"],
        resources: [`arn:${this.partition}:ec2:${this.region}:${this.account}:volume/*`],
        conditions: {
          StringEquals: {
            [`aws:RequestTag/${dataVolumeBackupTagKey}`]: dataVolumeBackupTagValue,
          },
          "ForAllValues:StringEquals": {
            "aws:TagKeys": [dataVolumeBackupTagKey],
          },
        },
      }),
    );

    // ──────────────────────────────────────
    // User data: install Docker, mount EBS, run container as systemd unit
    // ──────────────────────────────────────

    // Pin the server image by digest for deterministic rolls/rollback when provided
    // (`-c serverImageDigest=sha256:...`); otherwise track :latest. Build+push
    // first, capture the digest, then deploy pinned. See docs/DEPLOY.md.
    const serverImageDigest = this.node.tryGetContext("serverImageDigest") as
      | string
      | undefined;
    if (serverImageDigest !== undefined && !/^sha256:[0-9a-f]{64}$/.test(serverImageDigest)) {
      throw new Error("serverImageDigest must be an immutable lowercase SHA-256 digest");
    }
    const containerImage = serverImageDigest
      ? `${ecrRepo.repositoryUri}@${serverImageDigest}`
      : `${ecrRepo.repositoryUri}:latest`;
    const awslogsGroup = logGroup.logGroupName;

    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      "set -eu",
      'echo "[pim-bootstrap] stage=host-packages"',
      "dnf update -y",
      "dnf install -y docker cronie",

      // The IF CIS nftables baseline keeps its forward base chain at policy drop.
      // Docker's separate base chain accepting a packet is not terminal across
      // nftables base chains, so explicitly allow Docker bridge traffic here while
      // retaining the IF default-deny policy for all other forwarded traffic.
      // Load the live rules before Docker starts; the include persists them across
      // reboot and is the Image Factory documented Docker/Compose integration.
      "install -d -m 0755 /etc/nftables",
      "cat > /etc/nftables/pim-docker.rules <<'NFT_EOF'",
      'add rule inet filter forward oifname "br-*" counter accept comment "PIM Docker user bridge"',
      'add rule inet filter forward iifname "br-*" counter accept comment "PIM Docker user bridge"',
      'add rule inet filter forward oifname "docker0" counter accept comment "PIM Docker default bridge"',
      'add rule inet filter forward iifname "docker0" counter accept comment "PIM Docker default bridge"',
      "NFT_EOF",
      `if ! grep -Fq 'include "/etc/nftables/pim-docker.rules"' /etc/sysconfig/nftables.conf; then`,
      `  echo 'include "/etc/nftables/pim-docker.rules"' >> /etc/sysconfig/nftables.conf`,
      "fi",
      `if ! nft -a list chain inet filter forward | grep -Fq 'PIM Docker default bridge'; then`,
      "  nft -f /etc/nftables/pim-docker.rules",
      "fi",
      "systemctl enable --now docker",
      "systemctl enable --now crond",

      // Security agents (CrowdStrike Falcon EDR + Splunk Universal Forwarder for
      // Security Splunk) are NOT installed here. The host boots from an Adobe Image
      // Factory AL2023 base image (see machineImage below) that bakes in and
      // auto-configures both: Falcon resolves the correct CID/tags from this AWS
      // account, and the Splunk UF is pre-configured via the Honeydew deployment
      // server. IF images are tested for EDR/Splunk/Hubble before release.
      // See docs/EDR_INSTALL_RUNBOOK.md.

      // Mount the secondary EBS volume at /data. IF images also contain an xvdk
      // scratch volume, so never assume nvme1n1 is /dev/sdb. Resolve the original
      // EBS device mapping via ebsnvme-id and persist the filesystem by UUID so an
      // NVMe enumeration change on reboot cannot mount the wrong volume.
      'echo "[pim-bootstrap] stage=data-volume-mount"',
      'DATA_DEV=""',
      "for ATTEMPT in $(seq 1 60); do",
      "  for CANDIDATE in /dev/nvme*n1 /dev/sdb /dev/xvdb; do",
      '    [ -b "$CANDIDATE" ] || continue',
      '    MAPPED=""',
      '    if [ -x /sbin/ebsnvme-id ]; then MAPPED=$(/sbin/ebsnvme-id -u "$CANDIDATE" 2>/dev/null || true); fi',
      '    case "$MAPPED:$CANDIDATE" in *sdb*|*xvdb*) DATA_DEV="$CANDIDATE"; break 2 ;; esac',
      "  done",
      "  sleep 2",
      "done",
      '[ -n "$DATA_DEV" ] || { echo "Unable to locate /dev/sdb data volume" >&2; exit 1; }',
      'if ! blkid "$DATA_DEV" >/dev/null 2>&1; then',
      '  mkfs -t ext4 "$DATA_DEV"',
      "fi",
      "mkdir -p /data",
      'DATA_UUID=$(blkid -s UUID -o value "$DATA_DEV")',
      'if ! grep -Fq "UUID=$DATA_UUID /data " /etc/fstab; then',
      '  echo "UUID=$DATA_UUID /data ext4 defaults,nofail 0 2" >> /etc/fstab',
      "fi",
      "mount /data",
      "mkdir -p /data/knowledge-graph",

      // Tag the exact EBS volume attached as /dev/sdb. AWS Backup's tag-based
      // selection is dynamic, so replacement instances are protected without a
      // stack update or a hard-coded volume ID.
      'echo "[pim-bootstrap] stage=instance-and-backup-tag"',
      'INSTANCE_ID_FILE=/sys/devices/virtual/dmi/id/board_asset_tag',
      '[ -r "$INSTANCE_ID_FILE" ] || { echo "EC2 instance-id sysfs file is unavailable" >&2; exit 1; }',
      'INSTANCE_ID=$(tr -d "[:space:]" < "$INSTANCE_ID_FILE")',
      'case "$INSTANCE_ID" in i-*) ;; *) echo "Invalid EC2 instance ID from sysfs" >&2; exit 1 ;; esac',
      'DATA_VOLUME_ID=""',
      "for ATTEMPT in $(seq 1 30); do",
      `  DATA_VOLUME_ID=$(aws ec2 describe-volumes --region ${this.region} --filters "Name=attachment.instance-id,Values=$INSTANCE_ID" "Name=attachment.device,Values=/dev/sdb" --query 'Volumes[0].VolumeId' --output text 2>/dev/null || true)`,
      '  case "$DATA_VOLUME_ID" in vol-*) break ;; esac',
      '  DATA_VOLUME_ID=""',
      "  sleep 2",
      "done",
      '[ -n "$DATA_VOLUME_ID" ] || { echo "Unable to resolve /dev/sdb EBS volume ID" >&2; exit 1; }',
      `aws ec2 create-tags --region ${this.region} --resources "$DATA_VOLUME_ID" --tags Key=${dataVolumeBackupTagKey},Value=${dataVolumeBackupTagValue}`,

      // ECR login
      'echo "[pim-bootstrap] stage=image-pull"',
      `aws ecr get-login-password --region ${this.region} | docker login --username AWS --password-stdin ${this.account}.dkr.ecr.${this.region}.amazonaws.com`,
      `docker pull ${containerImage}`,

      // systemd unit for the server
      'echo "[pim-bootstrap] stage=service-install"',
      "cat > /etc/systemd/system/pim-server.service <<'UNIT_EOF'",
      "[Unit]",
      "Description=PIM Server",
      "Requires=docker.service",
      "After=docker.service",
      "RequiresMountsFor=/data",
      "",
      "[Service]",
      "Restart=always",
      "RestartSec=5",
      "TimeoutStopSec=30",
      "ExecStartPre=-/usr/bin/docker stop pim-server",
      "ExecStartPre=-/usr/bin/docker rm pim-server",
      `ExecStart=/usr/bin/docker run --rm --name pim-server -p 4000:4000 \\`,
      `  -v /data:/data \\`,
      ...(memoryCutoverComplete
        ? [`  -v /data/knowledge-graph:/data/knowledge-graph:ro \\`]
        : []),
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
      ...(memoryCutoverComplete
        ? [`  -e PIM_MEMORY_REQUIRE_CANONICAL_AUTHORITY=1 \\`]
        : []),
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
      'echo "[pim-bootstrap] stage=cron-install"',
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
      // deploying the production stack there. See docs/EDR_INSTALL_RUNBOOK.md.
      machineImage: ec2.MachineImage.genericLinux({
        "us-west-2": "ami-06afdfc08e9b14b7e", // IF_Amazon-Linux-2023_aws_2.0.0, Falcon 7.23
      }),
      role: ec2Role,
      securityGroup: ec2Sg,
      userData,
      // Containers add one network hop when calling IMDS. Require IMDSv2 while
      // allowing its token/credential response to cross the Docker bridge.
      requireImdsv2: true,
      httpPutResponseHopLimit: 2,
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

    // Full-volume recovery points are incremental at the EBS layer: after the
    // first snapshot, AWS stores only changed blocks. Keep dense recent points
    // for operational recovery and progressively thinner long-lived points.
    const dataBackupVault = new backup.BackupVault(this, "DataBackupVault", {
      backupVaultName: `pim-${owner}-data`,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    const dataBackupPlan = new backup.BackupPlan(this, "DataBackupPlan", {
      backupPlanName: `pim-${owner}-data`,
      backupVault: dataBackupVault,
      backupPlanRules: [
        new backup.BackupPlanRule({
          ruleName: "hourly-2-days",
          scheduleExpression: events.Schedule.cron({ minute: "15" }),
          deleteAfter: cdk.Duration.days(2),
          startWindow: cdk.Duration.hours(1),
          completionWindow: cdk.Duration.hours(6),
          recoveryPointTags: { PimBackupTier: "hourly" },
        }),
        new backup.BackupPlanRule({
          ruleName: "daily-30-days",
          scheduleExpression: events.Schedule.cron({ minute: "30", hour: "2" }),
          deleteAfter: cdk.Duration.days(30),
          startWindow: cdk.Duration.hours(1),
          completionWindow: cdk.Duration.hours(6),
          recoveryPointTags: { PimBackupTier: "daily" },
        }),
        new backup.BackupPlanRule({
          ruleName: "weekly-12-weeks",
          scheduleExpression: events.Schedule.cron({ minute: "30", hour: "3", weekDay: "SUN" }),
          deleteAfter: cdk.Duration.days(84),
          startWindow: cdk.Duration.hours(1),
          completionWindow: cdk.Duration.hours(6),
          recoveryPointTags: { PimBackupTier: "weekly" },
        }),
      ],
    });
    dataBackupPlan.addSelection("DataVolumeSelection", {
      backupSelectionName: `pim-${owner}-data-volumes`,
      resources: [
        backup.BackupResource.fromTag(dataVolumeBackupTagKey, dataVolumeBackupTagValue),
      ],
      allowRestores: true,
    });
    new events.Rule(this, "BackupJobFailureRule", {
      description: "Route terminal AWS Backup job failures to PIM operations alerts",
      eventPattern: {
        source: ["aws.backup"],
        detailType: ["Backup Job State Change"],
        detail: { state: ["ABORTED", "EXPIRED", "FAILED"] },
      },
      targets: [new eventTargets.SnsTopic(operationsAlerts)],
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

    addOperationsAlarm("ServerUnhealthyTargetAlarm", {
      alarmName: `pim-${owner}-server-unhealthy-target`,
      alarmDescription: "The single PIM target is unhealthy or unavailable",
      metric: targetGroup.metrics.unhealthyHostCount({
        statistic: "Maximum",
        period: cdk.Duration.minutes(1),
      }),
      threshold: 0,
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
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

    // Scope SPA fallback to the UI behavior. A distribution-wide custom 403
    // response would also rewrite legitimate API/MCP authorization failures to
    // index.html, hiding the status and JSON body from clients.
    const spaRewrite = new cloudfront.Function(this, "SpaRewrite", {
      code: cloudfront.FunctionCode.fromInline(`
function handler(event) {
  var request = event.request;
  if (request.uri.indexOf(".") === -1) {
    request.uri = "/index.html";
  }
  return request;
}
`),
    });

    const distribution = new cloudfront.Distribution(this, "PimCdn", {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(uiBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        functionAssociations: [
          {
            function: spaRewrite,
            eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
          },
        ],
      },
      additionalBehaviors: {
        "/mcp": apiBehavior,
        "/mcp/*": apiBehavior,
        "/api/*": apiBehavior,
        "/ws": apiBehavior,
        "/ws/*": apiBehavior,
        // Tunnel proxy — forwards dev-preview traffic to the ALB. Matches
        // `/tunnel/{tunnelId}/{shareToken}[/*]` served by the Fastify server.
        "/tunnel/*": apiBehavior,
      },
      defaultRootObject: "index.html",
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
    new cdk.CfnOutput(this, "OperationsAlertTopicArn", { value: operationsAlerts.topicArn });
    new cdk.CfnOutput(this, "DataBackupVaultName", { value: dataBackupVault.backupVaultName });
    new cdk.CfnOutput(this, "DataBackupPlanId", { value: dataBackupPlan.backupPlanId });
    new cdk.CfnOutput(this, "EcrRepoUri", { value: ecrRepo.repositoryUri });
    new cdk.CfnOutput(this, "AutoScalingGroupName", { value: asg.autoScalingGroupName });
    new cdk.CfnOutput(this, "MemoryCutoverComplete", {
      value: memoryCutoverComplete ? "true" : "false",
      description: "Terminal canonical-memory fence state carried forward by deployments",
    });
    new cdk.CfnOutput(this, "ServerImagePushAllowed", {
      value: allowServerImagePush ? "true" : "false",
      description: "Temporary scoped-host ECR push gate; must be false after a manual image build",
    });
    new cdk.CfnOutput(this, "LogGroupName", { value: logGroup.logGroupName });
    new cdk.CfnOutput(this, "DistributionId", { value: distribution.distributionId });
    new cdk.CfnOutput(this, "VpcId", { value: vpc.vpcId });
  }
}
