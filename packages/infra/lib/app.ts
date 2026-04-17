#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { PimStack } from "./pim-stack.js";

const app = new cdk.App();

new PimStack(app, "PimStack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? "us-west-2",
  },
});
