import assert from "node:assert/strict";
import test from "node:test";
import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { PimEc2Stack } from "../dist/pim-ec2-stack.js";

function stringLeaves(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(stringLeaves).join("");
  if (value && typeof value === "object") return Object.values(value).map(stringLeaves).join("");
  return "";
}

test("bootstrap reads and validates the Nitro instance ID before tagging the data volume", () => {
  const app = new cdk.App();
  const stack = new PimEc2Stack(app, "PimEc2Stack-test", {
    owner: "test",
    env: { account: "111122223333", region: "us-west-2" },
  });
  const template = Template.fromStack(stack);
  const resources = template.findResources("AWS::EC2::LaunchTemplate");
  assert.equal(Object.keys(resources).length, 1);

  const launchTemplate = Object.values(resources)[0].Properties.LaunchTemplateData;
  const userData = stringLeaves(launchTemplate.UserData);
  assert.match(userData, /\/sys\/devices\/virtual\/dmi\/id\/board_asset_tag/);
  assert.doesNotMatch(userData, /\/sys\/devices\/virtual\/dmi\/id\/board_asset(?:[\s'";)]|$)/);

  const validation = userData.indexOf('case "$INSTANCE_ID" in i-*');
  const describeVolumes = userData.indexOf("aws ec2 describe-volumes");
  const createTags = userData.indexOf("aws ec2 create-tags");
  const serviceFile = userData.indexOf("cat > /etc/systemd/system/pim-server.service");
  const cronFile = userData.indexOf("cat > /etc/cron.d/pim-backup");
  assert.ok(validation >= 0 && validation < describeVolumes);
  assert.ok(createTags >= 0 && createTags < serviceFile);
  assert.ok(serviceFile >= 0 && serviceFile < cronFile);
});

function kgWriteStatements(template) {
  const policies = template.findResources("AWS::IAM::Policy");
  return Object.values(policies).flatMap((policy) =>
    policy.Properties.PolicyDocument.Statement.filter((statement) => {
      const actions = [statement.Action ?? []].flat();
      const resources = stringLeaves(statement.Resource ?? "");
      return actions.some((action) => String(action).startsWith("s3:PutObject"))
        && resources.includes("KnowledgeGraphBucket");
    }),
  );
}

function ecrPushStatements(template) {
  const policies = template.findResources("AWS::IAM::Policy");
  return Object.values(policies).flatMap((policy) =>
    policy.Properties.PolicyDocument.Statement.filter((statement) => {
      const actions = [statement.Action ?? []].flat();
      const resources = stringLeaves(statement.Resource ?? "");
      return actions.includes("ecr:InitiateLayerUpload")
        && resources.includes("ServerRepo");
    }),
  );
}

test("memory cutover fence stays down until memoryCutoverComplete context is set", () => {
  const app = new cdk.App();
  const stack = new PimEc2Stack(app, "PimEc2Stack-precutover", {
    owner: "test",
    env: { account: "111122223333", region: "us-west-2" },
  });
  const template = Template.fromStack(stack);
  const launchTemplate = Object.values(
    template.findResources("AWS::EC2::LaunchTemplate"),
  )[0].Properties.LaunchTemplateData;
  const userData = stringLeaves(launchTemplate.UserData);

  assert.doesNotMatch(userData, /PIM_MEMORY_REQUIRE_CANONICAL_AUTHORITY/);
  assert.doesNotMatch(userData, /knowledge-graph:ro/);
  assert.ok(kgWriteStatements(template).length > 0,
    "pre-cutover role must keep knowledge-graph bucket write access");
  template.hasOutput("MemoryCutoverComplete", { Value: "false" });
});

test("memoryCutoverComplete=true raises the full memory cutover fence", () => {
  const app = new cdk.App({ context: { memoryCutoverComplete: "true" } });
  const stack = new PimEc2Stack(app, "PimEc2Stack-postcutover", {
    owner: "test",
    env: { account: "111122223333", region: "us-west-2" },
  });
  const template = Template.fromStack(stack);
  const launchTemplate = Object.values(
    template.findResources("AWS::EC2::LaunchTemplate"),
  )[0].Properties.LaunchTemplateData;
  const userData = stringLeaves(launchTemplate.UserData);

  assert.match(userData, /PIM_MEMORY_REQUIRE_CANONICAL_AUTHORITY=1/);
  assert.match(userData, /-v \/data\/knowledge-graph:\/data\/knowledge-graph:ro/);
  assert.equal(kgWriteStatements(template).length, 0,
    "post-cutover role must not retain knowledge-graph bucket write access");
  template.hasOutput("MemoryCutoverComplete", { Value: "true" });
});

test("server image context accepts only an immutable SHA-256 digest", () => {
  const digest = `sha256:${"a".repeat(64)}`;
  const app = new cdk.App({ context: { serverImageDigest: digest } });
  const stack = new PimEc2Stack(app, "PimEc2Stack-digest", {
    owner: "test",
    env: { account: "111122223333", region: "us-west-2" },
  });
  const template = Template.fromStack(stack);
  const launchTemplate = Object.values(
    template.findResources("AWS::EC2::LaunchTemplate"),
  )[0].Properties.LaunchTemplateData;
  assert.match(stringLeaves(launchTemplate.UserData), new RegExp(`@${digest}`));

  assert.throws(() => {
    const invalidApp = new cdk.App({ context: { serverImageDigest: "sha256:not-a-digest" } });
    new PimEc2Stack(invalidApp, "PimEc2Stack-invalid-digest", {
      owner: "test",
      env: { account: "111122223333", region: "us-west-2" },
    });
  }, /serverImageDigest must be an immutable lowercase SHA-256 digest/);
});

test("scoped host ECR push is denied by default and explicitly temporary", () => {
  const defaultApp = new cdk.App();
  const defaultStack = new PimEc2Stack(defaultApp, "PimEc2Stack-no-push", {
    owner: "test",
    env: { account: "111122223333", region: "us-west-2" },
  });
  const defaultTemplate = Template.fromStack(defaultStack);
  assert.equal(ecrPushStatements(defaultTemplate).length, 0);
  defaultTemplate.hasOutput("ServerImagePushAllowed", { Value: "false" });

  const buildApp = new cdk.App({ context: { allowServerImagePush: "true" } });
  const buildStack = new PimEc2Stack(buildApp, "PimEc2Stack-build-push", {
    owner: "test",
    env: { account: "111122223333", region: "us-west-2" },
  });
  const buildTemplate = Template.fromStack(buildStack);
  assert.ok(ecrPushStatements(buildTemplate).length > 0);
  buildTemplate.hasOutput("ServerImagePushAllowed", { Value: "true" });
});
