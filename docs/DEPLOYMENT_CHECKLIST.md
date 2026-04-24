# Deployment Checklist — Slack Escalation + Tunneling

Companion to `docs/DEPLOY.md`. Use this after the `PimEc2Stack` is deployed to
enable the two features end-to-end. Every step here is ops / infra config —
no code changes required.

Architecture context: the server runs as a single Node process on EC2 behind
ALB + CloudFront. `packages/server/scripts/fetch-secrets.sh` fetches every
parameter under `/pim/*` in SSM at container start and exports each as an env
var (parameter `/pim/SLACK_BOT_TOKEN` → env `SLACK_BOT_TOKEN`). Adding new
functionality typically means: put a value in SSM, restart the instance.

## 1. Slack Conflict Escalation

### 1a. Create the Slack app
- [ ] Create a new Slack app in the Adobe workspace (`api.slack.com/apps` →
      "Create New App" → "From scratch").
- [ ] Under **OAuth & Permissions**, add bot token scopes:
  - `chat:write` — post messages
  - `chat:write.public` — post to channels the bot hasn't been invited to
  - `users:read` — required for `@`-mention resolution lookups
- [ ] Install the app to the workspace. Copy the **Bot User OAuth Token**
      (starts with `xoxb-`).
- [ ] Pick a channel for conflict notifications. Invite the bot
      (`/invite @PIM`). Copy the channel ID from the channel URL
      (`C0XXXXXXXXX`).

### 1b. Populate SSM
```sh
aws ssm put-parameter --name /pim/SLACK_BOT_TOKEN  --type SecureString --value "xoxb-..." --overwrite
aws ssm put-parameter --name /pim/SLACK_CHANNEL_ID --type String       --value "C0XXXXXXXXX" --overwrite
```

### 1c. Reload the instance
`fetch-secrets.sh` runs at container boot. To pick up the new values:
```sh
# Either restart the systemd unit via SSM Run Command:
aws ssm send-command \
  --document-name AWS-RunShellScript \
  --targets Key=tag:Name,Values=pim-ec2 \
  --parameters 'commands=["systemctl restart pim"]'

# Or replace the instance by bumping the ASG (safer for a dirty host):
aws autoscaling start-instance-refresh --auto-scaling-group-name <ASG name from CDK output>
```

### 1d. Verify
- [ ] Create a test conflict via the SDK (or the UI) and confirm a message
      appears in the Slack channel within a few seconds.
- [ ] Resolve the conflict; confirm the `:white_check_mark:` message posts as
      a **thread reply** under the original, not a new top-level message.
- [ ] CloudWatch: look for `[slack]` error lines — should be absent.

### 1e. (Optional) Enable `@`-mentions
The service resolves agent IDs → Slack user IDs by looking up
`identity_cache` rows keyed on `email`. For this to work, the identity
resolver (`services/identity-resolver.ts`) needs a Slack user token:
- [ ] Create a Slack user token with `users:read.email` and add to SSM as
      `/pim/SLACK_USER_TOKEN_MWP` (or one of the other variants the resolver
      tries — see `identity-resolver.ts:94`). Without this, mentions fall
      back to the raw agent-id string (notifications still work).

## 2. Tunneling (Dev Previews)

### 2a. Populate `TUNNEL_BASE_URL`
The server builds shareable tunnel URLs using `process.env.TUNNEL_BASE_URL`
as the base. In prod this should be the publicly-reachable hostname — the
CloudFront distribution URL (or a branded domain, see §2d).

```sh
# Use the CloudFront URL output by the CDK stack
aws ssm put-parameter --name /pim/TUNNEL_BASE_URL \
  --type String \
  --value "https://d1ygncl0yqo6sv.cloudfront.net" --overwrite
```

Restart the instance (see §1c).

### 2b. Confirm CloudFront routing
The stack already forwards `/tunnel/*` to the ALB. Verify:
```sh
curl -I https://d1ygncl0yqo6sv.cloudfront.net/tunnel/does-not-exist/token
# Expect: 401 Unauthorized (tunnel-proxy handler rejects bad token)
# NOT:    403 or a 404 HTML page from S3 (which would mean CloudFront routed to UI)
```

### 2c. End-to-end smoke test
- [ ] On a dev machine, start a local dev server (e.g., `vite --port 3000`).
- [ ] Run `pim tunnel start --pod <id> --port 3000 --branch <name>` pointing
      the CLI at the prod server.
- [ ] Copy the URL from the Tunnels dashboard (`<CloudFront>/tunnel/{id}/{token}`).
- [ ] Open in an incognito window **with no IMS session** — the page should
      load. This is the external-collaborator use case.
- [ ] Tamper the token path segment (e.g., flip a character). Expect 401.

### 2d. (Optional) Branded domain at CloudFront
CloudFront ships with a `.cloudfront.net` URL that works for internal use.
For a branded domain (`pim.{org}.com`):
- [ ] Request an ACM certificate for the wildcard (e.g., `*.pim.corp.adobe.com`)
      in **us-east-1** (CloudFront requires certs in that region).
- [ ] Add `domainNames` + `certificate` to the `cloudfront.Distribution`
      props in `packages/infra/lib/pim-ec2-stack.ts` and redeploy.
- [ ] Create a Route 53 alias record (A or AAAA) pointing to the
      distribution.
- [ ] Update `/pim/TUNNEL_BASE_URL` to the branded domain and restart.

### 2e. Revoking a leaked tunnel URL
```sh
# SSH to the instance and use sqlite3:
sqlite3 /data/pim.db \
  "UPDATE tunnels SET status='disconnected' WHERE tunnel_id='<id>';"
# The proxy will now 502 since the tunnel's WS registration still lives
# in-memory; to also reject cached URLs, rotate the share_token:
sqlite3 /data/pim.db \
  "UPDATE tunnels SET share_token=lower(hex(randomblob(16))) WHERE tunnel_id='<id>';"
```

## 3. IAM Sanity Checks

The EC2 instance role needs read access to `/pim/*`. Verify once:
```sh
# From a shell on the instance:
aws ssm get-parameters-by-path --path /pim/ --with-decryption --region $AWS_REGION \
  --query 'length(Parameters[*].Name)'
# Expect: integer ≥ 4 (SLACK_BOT_TOKEN, SLACK_CHANNEL_ID, TUNNEL_BASE_URL, plus existing ones)
```
If this fails with `AccessDeniedException`, the instance role is missing
`ssm:GetParametersByPath` / `kms:Decrypt`. The CDK stack grants both; if the
stack was deployed before these parameters existed, no redeploy is needed
since the IAM policy is path-scoped (`/pim/*`), not parameter-scoped.

Tail `/var/log/cloud-init-output.log` (or `journalctl -u pim`) after restart
for `[fetch-secrets] Loaded N parameter(s)` — N should include the new vars.

## 4. Observability

### 4a. Slack delivery failures
- [ ] Create a CloudWatch Logs **metric filter** on the PIM log group with
      pattern `"[slack] Failed"` → metric `SlackDeliveryFailures`.
- [ ] Alarm: `> 3` in 5 minutes → SNS → oncall.

### 4b. Escalation tick liveness
The `setInterval` in `packages/server/src/index.ts:149` drives all
escalation. If the Node process wedges silently, nothing escalates.
- [ ] Metric filter on `"Escalation check failed"` log lines.
- [ ] Optional: synthetic check — every hour, script creates+resolves a
      throwaway conflict in a `_canary` pod and asserts a Slack message
      fired.

### 4c. Tunnel proxy health
- [ ] Metric filter on `"Tunnel not connected"` (502 responses).
      Spike = CLI tunnel processes are dying; worth a page if sustained.

## 5. Runbook Entries

### Rotate the Slack bot token
1. Regenerate the token in the Slack app UI.
2. `aws ssm put-parameter --name /pim/SLACK_BOT_TOKEN --value "xoxb-..." --overwrite --type SecureString`
3. Restart the instance (§1c). No redeploy.

### Slack is posting duplicate escalations
Cause: the bot is a member of multiple overlapping channels, or
`SLACK_CHANNEL_ID` was changed without restart. Confirm `chat.postMessage`
is hitting one channel only; check the `slack_message_ts` column on the
conflict row — if it's NULL, thread-replies will fall back to new top-level
messages (expected behavior when the initial post failed).

### Tunnel share URL was leaked externally
Rotate the token (§2e). External users loading the old URL will get 401.
If escalation required, revoke by setting `status='disconnected'`.

---

Questions / gaps? Check in with the PIM oncall channel before editing
production SSM.
