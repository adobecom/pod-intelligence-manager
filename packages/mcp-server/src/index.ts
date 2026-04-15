#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools } from "./tools.js";

const server = new McpServer({
  name: "ai-council",
  version: "0.0.1",
});

registerTools(server);

const transport = new StdioServerTransport();
await server.connect(transport);
