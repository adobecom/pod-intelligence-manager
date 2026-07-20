# Security Compliance Agents Runbook (EDR + Splunk) — PIM EC2 Stack

Runbook for making the PIM server host compliant with two Adobe security requirements:

1. **EDR** — the CrowdStrike Falcon sensor (`falcon-sensor`) must run on the host.
2. **Splunk syslog forwarding** — host OS syslog must be forwarded to Security Splunk.

Both are satisfied at once by booting the host from an **Adobe Image Factory (IF)
Amazon Linux 2023 base image** instead of the stock AL2023 image. This is the
approach SIO recommends for AL2023, and it is the fix implemented here.

## The flagged resource

| Field | Value |
|---|---|
| Account ID | `947495650207` |
| Resource | Auto Scaling Group `PimEc2Stack-rkhan-ServerAsgASG768DC645-jRhXkQNdrl51` |
| ARN | `arn:aws:autoscaling:us-west-2:947495650207:autoScalingGroup:971830d2-bd85-49b6-a1aa-512eaad71c7a:autoScalingGroupName/PimEc2Stack-rkhan-ServerAsgASG768DC645-jRhXkQNdrl51` |
| Environment | Dev / sandbox |
| Region | us-west-2 |
| CDK source | `packages/infra/lib/pim-ec2-stack.ts` (`ServerLaunchTemplate`, `ServerAsg`) |

Reference: [EDR Installation Guide (SIO)](https://wiki.corp.adobe.com/spaces/SIO/pages/2507092838/EDR+Installation+Guide).

## Why the Image Factory image (and not a hand-rolled install)

The flagged resource is an Auto Scaling Group, so instances are cattle: any
replacement (a `cdk deploy` touching the launch template, an instance refresh, an
ELB health-check replacement, or spot/hardware loss) brings up a fresh host. A
by-hand install on the live box would be wiped by the next replacement and the
scanner would re-flag it. The durable fix has to live in the launch template.

Two agents are required, not one. Rather than hand-roll each into user-data (two
bespoke installs, two version/credential paths to own), we boot from an IF image
that bakes them in:

- **EDR is pre-installed and auto-configured.** Per SIO/Image Factory, "users don't
  need to configure anything... a service within the image automatically pulls the
  correct CID and TAGS for the account and configures it." The Falcon landscape tag
  (`DEV`/`STG`/`PRD`) and Business-Unit CID are derived from the **AWS account**, so
  the same code is correct for this sandbox account and for production.
- **Splunk is pre-installed and auto-configured.** The IF hardener installs and
  configures the Splunk Universal Forwarder (`/opt/splunkforwarder`) via
  `check_Honeydew`; it registers with the security deployment server, which pushes
  the syslog-forwarding apps. "All ImageFactory images are automatically tested for
  hubble, splunk and EDR working before release."

This is host OS security logging, separate from the app logs the container already
ships to CloudWatch (`awslogs`).

## The fix (implemented)

`packages/infra/lib/pim-ec2-stack.ts`:

- **`machineImage` now resolves the IF AL2023 image** (flavor `IF_Amazon-Linux-2023_aws`):

  ```ts
  machineImage: ec2.MachineImage.lookup({
    name: "IF_Amazon-Linux-2023_aws_*",
    owners: ["993267408692"],
    filters: { architecture: ["x86_64"], state: ["available"] },
  }),
  ```

  As of 2026-07 this resolves to `IF_Amazon-Linux-2023_aws_2.0.0`
  (`ami-06afdfc08e9b14b7e`, us-west-2, Falcon 7.23). `cdk synth` confirms it resolves
  in account `947495650207`. The `-ECS` / `-ARM` / `-EKS` / `-EMR` flavors are for
  those runtimes; PIM runs Docker on plain EC2, so the base flavor is correct.

- **The hand-rolled `falcon-sensor` user-data block was removed** — the IF image
  makes it redundant.

### Notes on the `lookup`

- `lookup()` is region-agnostic and picks the newest matching image at synth time,
  caching the result in `packages/infra/cdk.context.json`. To pick up a newer IF
  release, run `npx cdk context --reset` (or delete the cached `ami:...` key) and
  redeploy. This is also how patching is handled: IF re-bakes images with patched
  bases; consuming a newer image is the update path (see Patching below).
- To pin an exact AMI instead of auto-resolving, swap in:
  `ec2.MachineImage.genericLinux({ "us-west-2": "ami-06afdfc08e9b14b7e" })`.

## Prerequisites to check before deploying

- **AMI sharing (this account): done.** `IF_Amazon-Linux-2023_aws_2.0.0` is already
  shared to `947495650207` in us-west-2 (verified via `describe-images`).
- **Account -> CID mapping.** EDR auto-config resolves the CID/tags from the AWS
  account. Confirm `947495650207` maps to the correct Business Unit CID in Image
  Factory's account map (`git.corp.adobe.com/image-factory/am-aws-accounts`,
  `etc/accounts.json`), or ask `#imagefactory-support`. If it is unmapped, the sensor
  may register with a wrong/default CID. This is verifiable after boot via Falcon Bot.
- **Production account.** `pim-ec2-stack.ts` is shared with prod. Before deploying the
  prod stack, confirm the IF AL2023 AMI is shared to the prod account+region too.

## Deploy and roll the instance

```bash
cd packages/infra
npx cdk ls                      # confirm the stack id
npx cdk diff PimEc2Stack-rkhan  # review: launch-template AMI change + removed user-data

npx cdk deploy PimEc2Stack-rkhan

# Roll the running instance so it launches from the IF image.
# The ASG is min=max=desired=1, so this is a brief single-instance outage.
aws autoscaling start-instance-refresh --region us-west-2 \
  --auto-scaling-group-name PimEc2Stack-rkhan-ServerAsgASG768DC645-jRhXkQNdrl51
```

After the refresh, confirm `pim-server` is healthy (ALB target healthy, `/api/health`
returns 200) — the IF base is hardened, so watch the first boot in case the Docker
install step in user-data needs a tweak.

## Verify (both agents)

**EDR (Falcon Bot):** on the new instance via SSM (the SG allows only port 4000 from
the ALB, so there is no SSH path; the instance role has `AmazonSSMManagedInstanceCore`):

```bash
INSTANCE_ID=$(aws autoscaling describe-auto-scaling-groups --region us-west-2 \
  --auto-scaling-group-names PimEc2Stack-rkhan-ServerAsgASG768DC645-jRhXkQNdrl51 \
  --query 'AutoScalingGroups[0].Instances[].InstanceId' --output text)

aws ssm send-command --region us-west-2 --instance-ids "$INSTANCE_ID" \
  --document-name AWS-RunShellScript \
  --parameters '{"commands":[
    "/opt/CrowdStrike/falconctl -g --cid --aid --tags",
    "systemctl is-active falcon-sensor splunk || systemctl is-active SplunkForwarder"
  ]}' --query 'Command.CommandId' --output text
```

Take the CID + AID, go to Slack `#edr-falconbot`, and run `/falconbot <CID> <AID>`.
A healthy result (RFM Status `no`, correct tags) closes the EDR requirement.
See [How to verify a sensor with Falcon Bot (SIO 2594456080)](https://wiki.corp.adobe.com/spaces/SIO/pages/2594456080/How+to+verify+a+sensor+with+Falcon+Bot).

**Splunk:** confirm the forwarder is running (above) and that events land in Security
Splunk. If logs do not appear, check outbound connectivity to the deployment server
`splunkds-ext.adobe.net:8089` and see
[Getting Your Logs into Security Splunk SCC (ELP)](https://wiki.corp.adobe.com/spaces/ELP/pages/2692267567/Getting+Your+Logs+into+Security+Splunk+SCC);
contact `scc-soc@adobe.com`.

## Patching

The colleague's auto-patching suggestion (unattended-upgrades) is Debian/Ubuntu; PIM is
Amazon Linux 2023. With the IF approach, patching is handled by **consuming refreshed IF
images**: IF re-bakes with patched bases, and `cdk context --reset` + redeploy rolls the
host onto the newer image. If you also want between-image OS security patching, enable
`dnf-automatic` (security-only) in user-data — but note in-place kernel changes are best
avoided on EDR hosts; on AL2023 Falcon runs in user mode (eBPF, kernel-independent), so
the risk is lower than kernel-mode hosts.

## Fallback: hand-rolled install (only if the IF image cannot be used)

If IF is unavailable for a flavor, install both agents in user-data / via SSM:

- **EDR:** pull `falcon-sensor-current-PRD` from Artifactory `rpm-edr-release/AmazonLinux`
  (user mode needs sensor >= 7.20, SELinux not Enforced), then
  `falconctl -s --cid=<BU CID>` and `--tags="<DEV|STG|PRD>,JIRA-<TICKET>,SVC-<serviceId>"`.
  CID by BU is in the [EDR CID Table (SIO 2549024123)](https://wiki.corp.adobe.com/spaces/SIO/pages/2549024123/EDR+CID+Table).
- **Splunk:** install the Universal Forwarder, point `deploymentclient.conf` at
  `splunkds-ext.adobe.net:8089`, start it, and let the DS push the syslog apps.

This path means you own the agent versions, credentials, and tags yourself, which is
exactly the toil the IF image avoids.

## References

- [EDR Installation Guide (SIO 2507092838)](https://wiki.corp.adobe.com/spaces/SIO/pages/2507092838/EDR+Installation+Guide)
- [Using Linux EDR Images (imagefactory 2594448649)](https://wiki.corp.adobe.com/spaces/imagefactory/pages/2594448649/Using+Linux+EDR+Images)
- [EDR implementation in ImageFactory (2512667476)](https://wiki.corp.adobe.com/spaces/imagefactory/pages/2512667476/EDR+implementation+in+ImageFactory)
- [Identifying Images from Image Factory (3151704706)](https://wiki.corp.adobe.com/spaces/imagefactory/pages/3151704706/Identifying+Images+from+Image+Factory)
- [Image Factory - Splunk Forwarder (1660410116)](https://wiki.corp.adobe.com/spaces/imagefactory/pages/1660410116/Image+Factory+-+Splunk+Forwarder)
- [Getting Your Logs into Security Splunk SCC (ELP 2692267567)](https://wiki.corp.adobe.com/spaces/ELP/pages/2692267567/Getting+Your+Logs+into+Security+Splunk+SCC)
- [EDR CID Table (SIO 2549024123)](https://wiki.corp.adobe.com/spaces/SIO/pages/2549024123/EDR+CID+Table)
- [How to verify a sensor with Falcon Bot (SIO 2594456080)](https://wiki.corp.adobe.com/spaces/SIO/pages/2594456080/How+to+verify+a+sensor+with+Falcon+Bot)
- Slack: `#edr-falconbot`, `#edr-operations-support`, `#imagefactory-support`
