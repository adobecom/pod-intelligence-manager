#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { CouncilStack } from "./council-stack.js";

const app = new cdk.App();

new CouncilStack(app, "CouncilStack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? "us-west-2",
  },
});
