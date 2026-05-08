import type { Task } from "../types.js";

export const eventCreateRest: Task = {
  id: "event-create-rest",
  type: "code",
  podId: "pod-emc-rbac",
  tags: ["events"],
  prompt: [
    "Implement `updateEvent(eventId: string, patch: Record<string, unknown>, modificationTime: string): Promise<{ ok: boolean; status: number; body: unknown }>` for the EMC platform.",
    "",
    "Behavior:",
    "- Send `PUT /events/:eventId` with the patch as JSON body and the `modificationTime` field included in the body.",
    "- Use `https://api.emc.adobe.com` as the base URL.",
    "- Use the global `fetch` function.",
    "- Return `{ ok: response.ok, status: response.status, body: await response.json() }`.",
    "- The endpoint may return 409 on a modificationTime mismatch — pass that through as `{ ok: false, status: 409, body }`.",
    "- This is a REST endpoint, not GraphQL.",
    "",
    "Export the function as a named export `updateEvent`.",
  ].join("\n"),
  expectedSignals: ["PUT", "REST", "modificationTime", "409"],
  testHarness: [
    "type FetchInit = { method?: string; body?: string; headers?: Record<string, string> };",
    "const calls: Array<{ url: string; init?: FetchInit }> = [];",
    "(globalThis as any).__calls = calls;",
    "(globalThis as any).__nextResponse = { ok: true, status: 200, json: async () => ({ id: 'evt-1', modificationTime: 't2' }) };",
    "(globalThis as any).fetch = async (url: string, init?: FetchInit) => {",
    "  calls.push({ url, init });",
    "  return (globalThis as any).__nextResponse;",
    "};",
  ].join("\n"),
  tests: [
    {
      name: "sends a PUT to /events/:id",
      body: [
        "const calls = (globalThis as any).__calls as Array<{ url: string; init: any }>;",
        "calls.length = 0;",
        "await mod.updateEvent('evt-1', { title: 'Updated' }, 't1');",
        "assert.equal(calls.length, 1);",
        "assert.equal(calls[0].init?.method, 'PUT', `method should be PUT, got ${calls[0].init?.method}`);",
        "assert.ok(calls[0].url.endsWith('/events/evt-1'), `url should end with /events/evt-1, got ${calls[0].url}`);",
      ].join("\n"),
    },
    {
      name: "includes modificationTime in the request body",
      body: [
        "const calls = (globalThis as any).__calls as Array<{ url: string; init: any }>;",
        "calls.length = 0;",
        "await mod.updateEvent('evt-2', { title: 'X' }, 'mod-time-abc');",
        "const body = JSON.parse(calls[0].init.body);",
        "assert.equal(body.modificationTime, 'mod-time-abc');",
      ].join("\n"),
    },
    {
      name: "returns 409 with body on modificationTime mismatch",
      body: [
        "(globalThis as any).__nextResponse = {",
        "  ok: false, status: 409,",
        "  json: async () => ({ error: 'modification_time_mismatch', current: 't5' }),",
        "};",
        "const out = await mod.updateEvent('evt-3', { title: 'X' }, 't1');",
        "assert.equal(out.ok, false);",
        "assert.equal(out.status, 409);",
        "assert.equal((out.body as any).current, 't5');",
      ].join("\n"),
    },
    {
      name: "does not use a GraphQL endpoint",
      body: [
        "const calls = (globalThis as any).__calls as Array<{ url: string; init: any }>;",
        "calls.length = 0;",
        "await mod.updateEvent('evt-x', { title: 'X' }, 't1');",
        "assert.ok(!calls[0].url.includes('graphql'), 'must not use a GraphQL endpoint — REST was the documented decision');",
      ].join("\n"),
    },
  ],
};
