#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { PimEc2Stack } from "./pim-ec2-stack.js";
// Path C reference (Lambda + DynamoDB) — kept on disk for future migration; not deployed.
// import { PimStack } from "./pim-stack.js";

const app = new cdk.App();

// Namespace per user so multiple devs can share this account without collision.
// Override with `-c owner=someoneElse` on the CLI if needed.
const owner = (app.node.tryGetContext("owner") as string | undefined) ?? "rkhan";

const stack = new PimEc2Stack(app, `PimEc2Stack-${owner}`, {
  owner,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? "us-west-2",
  },
});

cdk.Tags.of(stack).add("Owner", owner);
cdk.Tags.of(stack).add("Project", "pim-demo");
cdk.Tags.of(stack).add("Environment", "sandbox");
cdk.Tags.of(stack).add("ManagedBy", "cdk");
