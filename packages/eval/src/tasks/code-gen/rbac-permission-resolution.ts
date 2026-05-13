import type { Task } from "../types.js";

export const rbacPermissionResolution: Task = {
  id: "rbac-permission-resolution",
  type: "code",
  podId: "pod-emc-rbac",
  tags: ["rbac", "smoke"],
  prompt: [
    "Implement `resolvePermissions(userId: string, groupId: string): Promise<{ scopes: string[], roles: string[] }>` for the EMC platform.",
    "",
    "Required behavior:",
    "- Call the ESP API (`https://api.esp.adobe.com/v1/role:read`) with the header `x-adobe-esp-group-id` set to `groupId`.",
    "- The response shape is `{ scopes: string[], roles: string[] }`. Pass that through.",
    "- Use the global `fetch` function (already available).",
    "",
    "Export the function as a named export `resolvePermissions`.",
  ].join("\n"),
  expectedSignals: ["x-adobe-esp-group-id", "esp", "GroupContext"],
  testHarness: [
    "// Mock global fetch so the test can capture the call.",
    "type FetchInit = { headers?: Record<string, string> | Headers };",
    "const calls: Array<{ url: string; init?: FetchInit }> = [];",
    "(globalThis as any).__calls = calls;",
    "(globalThis as any).fetch = async (url: string, init?: FetchInit) => {",
    "  calls.push({ url, init });",
    "  return {",
    "    ok: true,",
    "    status: 200,",
    "    json: async () => ({ scopes: ['event:read', 'session:read'], roles: ['member'] }),",
    "  } as any;",
    "};",
  ].join("\n"),
  tests: [
    {
      name: "resolvePermissions returns scopes and roles from ESP API",
      body: [
        "const result = await mod.resolvePermissions('u-1', 'g-42');",
        "assert.deepEqual(result.scopes, ['event:read', 'session:read']);",
        "assert.deepEqual(result.roles, ['member']);",
      ].join("\n"),
    },
    {
      name: "resolvePermissions sends x-adobe-esp-group-id header",
      body: [
        "const calls = (globalThis as any).__calls as Array<{ url: string; init: any }>;",
        "calls.length = 0;",
        "await mod.resolvePermissions('u-1', 'g-99');",
        "assert.equal(calls.length, 1, 'fetch should be called exactly once');",
        "const headers = calls[0].init?.headers ?? {};",
        "const headerValue = headers instanceof Headers ? headers.get('x-adobe-esp-group-id') : (headers['x-adobe-esp-group-id'] ?? headers['X-Adobe-Esp-Group-Id']);",
        "assert.equal(headerValue, 'g-99', 'x-adobe-esp-group-id header must be set to the groupId');",
      ].join("\n"),
    },
    {
      name: "resolvePermissions targets the ESP role:read endpoint, not a static users.json",
      body: [
        "const calls = (globalThis as any).__calls as Array<{ url: string; init: any }>;",
        "calls.length = 0;",
        "await mod.resolvePermissions('u-1', 'g-1');",
        "const url = calls[0].url;",
        "assert.ok(!url.includes('users.json'), 'must not read from static users.json — that path is being deprecated (C-101)');",
        "assert.ok(url.includes('esp.adobe.com') && url.includes('role:read'), `expected ESP role:read endpoint, got ${url}`);",
      ].join("\n"),
    },
  ],
};
