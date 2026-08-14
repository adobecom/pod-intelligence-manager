# Host security agents (EDR + Splunk)

**Status:** current EC2 host configuration as of 2026-08-13

PIM satisfies its host EDR and Security Splunk requirements by booting the EC2 server from an
Adobe Image Factory Amazon Linux 2023 image. The image supplies and configures CrowdStrike Falcon,
the Splunk Universal Forwarder, and the surrounding host-hardening controls. Application container
logs continue to go to CloudWatch separately.

## Implemented configuration

`packages/infra/lib/pim-ec2-stack.ts` pins the launch template to an exact, shared x86_64 image:

```ts
machineImage: ec2.MachineImage.genericLinux({
  "us-west-2": "ami-06afdfc08e9b14b7e",
});
```

The pin currently identifies `IF_Amazon-Linux-2023_aws_2.0.0` in `us-west-2`. It is deliberate:
routine synthesis must not silently move the host to a newly published image. The stack does not
install Falcon or Splunk in user data.

Before using this stack in another account or region, verify that the intended Image Factory AMI
is shared there and add an explicitly reviewed mapping. The current map supports only
`us-west-2`.

## Routine application deploys

The normal deployment workflow updates the digest-pinned PIM container and its systemd unit. It
does not need to replace the EC2 host just to ship application code. Follow
[DEPLOY.md](./DEPLOY.md); do not start an instance refresh as part of a routine image release.

## Discover the current host

Resolve infrastructure identifiers from CloudFormation rather than copying a generated ASG name
or instance ID into this runbook:

```sh
STACK_NAME=PimEc2Stack-rkhan
ASG_NAME="$(aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --query 'Stacks[0].Outputs[?OutputKey==`AutoScalingGroupName`].OutputValue' \
  --output text)"
INSTANCE_ID="$(aws autoscaling describe-auto-scaling-groups \
  --auto-scaling-group-names "$ASG_NAME" \
  --query 'AutoScalingGroups[0].Instances[?LifecycleState==`InService`].InstanceId' \
  --output text)"
```

Confirm both values are non-empty and refer to the intended account and stack before issuing an
SSM command.

## Verify the agents

PIM exposes no SSH ingress; use SSM Session Manager or Run Command. On the in-service host, verify:

```sh
/opt/CrowdStrike/falconctl -g --cid --aid --tags
systemctl is-active falcon-sensor
systemctl is-active splunk || systemctl is-active SplunkForwarder
```

Then use the owning security team's approved Falcon verification and Security Splunk search to
confirm that:

- the Falcon AID is registered under the expected business unit and environment tags;
- Falcon is not in reduced-functionality mode; and
- recent host events arrive through the expected Splunk deployment-server configuration.

Do not place a CrowdStrike CID, registration credential, or Splunk credential in this repository.

## Updating the host image

Changing the AMI is a stateful host replacement, not a normal container deploy. PIM is a
single-writer SQLite service and each ASG instance receives its own `/data` EBS volume. A casual
rolling refresh can create two writers or boot from a database older than the final write.

Use a reviewed, planned-downtime stop-and-restore procedure:

1. Verify the new AMI is shared, matches the instance architecture, and supplies the required
   agents.
2. Pin its exact region-to-AMI mapping in CDK and review `cdk diff`.
3. Rehearse the hardened image, container boot, and restore outside the ALB.
4. Stop the only writer and periodic jobs.
5. Capture and verify a final logical backup, checksum, core manifest, and EBS recovery point.
6. Replace the instance while keeping the ASG at one writer.
7. Require fail-closed restore, compare the restored manifest, and only then return traffic.
8. Re-run the EDR and Splunk checks above.

See [BACKUP_RESTORE.md](./BACKUP_RESTORE.md) for current backup mechanics. Any new replacement must
use current stack outputs and scripts, not copied resource identifiers or status statements from a
past rollout.

## Patching policy

Consume a reviewed newer Image Factory release by changing the explicit AMI pin and performing the
safe replacement above. Do not reset CDK context expecting an image lookup: the current stack no
longer uses `MachineImage.lookup`. If between-image OS patching is required, coordinate it with the
host-security owner and validate Falcon/Splunk afterward; it is a separate operational change from
PIM container deployment.

## Escalation references

- [EDR Installation Guide](https://wiki.corp.adobe.com/spaces/SIO/pages/2507092838/EDR+Installation+Guide)
- [Using Linux EDR Images](https://wiki.corp.adobe.com/spaces/imagefactory/pages/2594448649/Using+Linux+EDR+Images)
- [Image Factory Splunk Forwarder](https://wiki.corp.adobe.com/spaces/imagefactory/pages/1660410116/Image+Factory+-+Splunk+Forwarder)
- [Security Splunk onboarding](https://wiki.corp.adobe.com/spaces/ELP/pages/2692267567/Getting+Your+Logs+into+Security+Splunk+SCC)
- Internal support: `#edr-falconbot`, `#edr-operations-support`, and
  `#imagefactory-support`
