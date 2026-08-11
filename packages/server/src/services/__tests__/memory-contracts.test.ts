import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  MEMORY_CONTRACT_FIXTURES,
  MEMORY_CONTRACT_FIXTURES_V2,
  MEMORY_CONTRACT_MAX_DEPTH,
  MEMORY_CONTRACT_SCHEMA,
  MEMORY_CONTRACT_SCHEMA_V2,
  MemoryContractValidationError,
  canonicalJsonSha256,
  canonicalizeJson,
  parseMemoryContract,
  parseMemoryContractV2,
  sha256Hex,
  type MemoryContractName,
  type MemoryContractNameV2,
} from "@pim/shared";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const sharedDir = path.resolve(testDir, "../../../../shared");

type SchemaNode = Record<string, unknown>;

function closedObjectPaths(
  node: SchemaNode,
  value: unknown,
  pathParts: Array<string | number> = [],
  output = new Map<string, Array<string | number>>(),
): Array<Array<string | number>> {
  if (typeof node.$ref === "string") {
    const name = node.$ref.replace("#/$defs/", "") as keyof typeof MEMORY_CONTRACT_SCHEMA.$defs;
    return closedObjectPaths(MEMORY_CONTRACT_SCHEMA.$defs[name] as SchemaNode, value, pathParts, output);
  }
  for (const keyword of ["allOf", "oneOf", "anyOf"] as const) {
    if (Array.isArray(node[keyword])) {
      for (const candidate of node[keyword] as SchemaNode[]) {
        closedObjectPaths(candidate, value, pathParts, output);
      }
    }
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    if (node.additionalProperties === false) output.set(JSON.stringify(pathParts), pathParts);
    const properties = node.properties && typeof node.properties === "object"
      ? node.properties as Record<string, SchemaNode>
      : {};
    for (const [name, child] of Object.entries(properties)) {
      if (Object.prototype.hasOwnProperty.call(value, name)) {
        closedObjectPaths(child, (value as Record<string, unknown>)[name], [...pathParts, name], output);
      }
    }
  }
  if (Array.isArray(value) && node.items && typeof node.items === "object") {
    value.forEach((child, index) =>
      closedObjectPaths(node.items as SchemaNode, child, [...pathParts, index], output));
  }
  return [...output.values()];
}

function valueAtPath(value: unknown, parts: Array<string | number>): Record<string, unknown> {
  let cursor = value;
  for (const part of parts) cursor = (cursor as Record<string | number, unknown>)[part];
  return cursor as Record<string, unknown>;
}

describe("memory v1 generated contracts", () => {
  it("validates every generated fixture against its published schema", () => {
    for (const [name, fixture] of Object.entries(MEMORY_CONTRACT_FIXTURES)) {
      expect(parseMemoryContract(name as MemoryContractName, fixture)).toEqual(fixture);
    }
  });

  it("rejects unknown schema versions without silently coercing them", () => {
    const request = structuredClone(MEMORY_CONTRACT_FIXTURES.MemorySearchV1) as Record<string, unknown>;
    request.schema_version = "pim.memory-search.v2";
    expect(() => parseMemoryContract("MemorySearchV1", request)).toThrow(MemoryContractValidationError);
  });

  it("rejects unknown trust-boundary fields", () => {
    const request = {
      ...structuredClone(MEMORY_CONTRACT_FIXTURES.MemorySearchV1),
      org_id: "caller-controlled-org",
    };
    try {
      parseMemoryContract("MemorySearchV1", request);
      throw new Error("expected validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(MemoryContractValidationError);
      expect((error as MemoryContractValidationError).issues).toContainEqual({
        path: "/org_id",
        reason: "unknown field",
      });
    }
  });

  it("rejects unknown nested lifecycle fields", () => {
    const record = structuredClone(MEMORY_CONTRACT_FIXTURES.MemoryRecordV1) as {
      lifecycle: Record<string, unknown>;
    };
    record.lifecycle.unreviewed_state = "active";
    try {
      parseMemoryContract("MemoryRecordV1", record);
      throw new Error("expected validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(MemoryContractValidationError);
      expect((error as MemoryContractValidationError).issues).toContainEqual({
        path: "/lifecycle/unreviewed_state",
        reason: "unknown field",
      });
    }
  });

  it("treats prototype-chain names as ordinary unknown fields for every object contract", () => {
    const prototypeNames = ["toString", "constructor", "hasOwnProperty", "valueOf", "__proto__"];
    for (const [name, fixture] of Object.entries(MEMORY_CONTRACT_FIXTURES)) {
      for (const property of prototypeNames) {
        const request = structuredClone(fixture) as Record<string, unknown>;
        Object.defineProperty(request, property, {
          configurable: true,
          enumerable: true,
          value: "attacker-controlled",
          writable: true,
        });
        try {
          parseMemoryContract(name as MemoryContractName, request);
          throw new Error(`expected ${name}.${property} validation to fail`);
        } catch (error) {
          expect(error).toBeInstanceOf(MemoryContractValidationError);
          expect((error as MemoryContractValidationError).issues).toContainEqual({
            path: `/${property}`,
            reason: "unknown field",
          });
        }
      }
    }
  });

  it("rejects prototype-chain names at every closed object path represented by the fixtures", () => {
    const prototypeNames = ["toString", "constructor", "hasOwnProperty", "__proto__"];
    for (const [name, fixture] of Object.entries(MEMORY_CONTRACT_FIXTURES)) {
      const definition = MEMORY_CONTRACT_SCHEMA.$defs[name as MemoryContractName] as SchemaNode;
      const paths = closedObjectPaths(definition, fixture);
      expect(paths.length).toBeGreaterThan(0);
      for (const objectPath of paths) {
        for (const property of prototypeNames) {
          const request = structuredClone(fixture);
          Object.defineProperty(valueAtPath(request, objectPath), property, {
            configurable: true,
            enumerable: true,
            value: "attacker-controlled",
            writable: true,
          });
          expect(() => parseMemoryContract(name as MemoryContractName, request))
            .toThrow(MemoryContractValidationError);
        }
      }
    }
  });

  it("rejects deeply nested unknown input with a controlled issue before recursive validation", () => {
    const request = structuredClone(MEMORY_CONTRACT_FIXTURES.MemorySearchV1) as Record<string, unknown>;
    const root: Record<string, unknown> = {};
    let cursor = root;
    for (let depth = 0; depth < 5_000; depth++) {
      const child: Record<string, unknown> = {};
      cursor.child = child;
      cursor = child;
    }
    Object.defineProperty(request, "toString", {
      configurable: true,
      enumerable: true,
      value: root,
      writable: true,
    });

    try {
      parseMemoryContract("MemorySearchV1", request);
      throw new Error("expected deep input validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(MemoryContractValidationError);
      expect(error).not.toBeInstanceOf(RangeError);
      expect((error as MemoryContractValidationError).issues).toEqual([
        expect.objectContaining({
          reason: `must not exceed a structural depth of ${MEMORY_CONTRACT_MAX_DEPTH}`,
        }),
      ]);
    }
  });

  it("keeps generated TypeScript artifacts current", () => {
    const generator = path.join(sharedDir, "scripts", "generate-memory-contracts.mjs");
    execFileSync(process.execPath, [generator, "--check"], { stdio: "pipe" });
  });
});

describe("memory v2 generated contracts", () => {
  it("validates every fixture and freezes explicit MCP non-exposure of history", () => {
    for (const [name, fixture] of Object.entries(MEMORY_CONTRACT_FIXTURES_V2)) {
      expect(parseMemoryContractV2(name as MemoryContractNameV2, fixture)).toEqual(fixture);
    }

    expect(MEMORY_CONTRACT_SCHEMA_V2.$defs.MemoryOperationSurfaceV2.properties.restricted_mcp.enum)
      .toEqual(["exposed", "not_exposed", "receipt_embedded", "excluded_control_plane"]);
    for (const planeName of ["codebase", "harness"] as const) {
      const plane = MEMORY_CONTRACT_FIXTURES_V2.MemoryCapabilitiesV2.planes
        .find(({ plane }) => plane === planeName);
      expect(plane?.operation_surfaces).toContainEqual({
        operation: "history",
        canonical_http: "available",
        restricted_mcp: "not_exposed",
      });
    }
  });

  it("publishes only supported planes and no retired standalone roots", () => {
    expect(MEMORY_CONTRACT_SCHEMA_V2.$defs.MemoryPlaneV2.enum)
      .toEqual(["codebase", "harness"]);
    expect(MEMORY_CONTRACT_SCHEMA_V2.$defs.MemoryResourceTypeV2.enum)
      .toEqual(["repository", "harness"]);
    const definitions = MEMORY_CONTRACT_SCHEMA_V2.$defs as Record<string, unknown>;
    for (const retired of [
      "ContentApplicabilityV2Alpha1",
      "OrgApplicabilityV2Alpha1",
      "ContentScopeSnapshotV2Alpha1",
      "OrgScopeSnapshotV2Alpha1",
      "ScopeSnapshotV2",
      "MemoryMcpScopeSnapshotV2",
      "ContentMemorySearchV2Alpha1",
      "OrgMemorySearchV2Alpha1",
      "MemoryCandidateV2",
      "MemoryCandidateSubmissionV2",
      "MemoryRuntimeAttestationV2",
      "MemoryRuntimeAttestationResultV2",
      "MemoryMcpCapabilitiesInputV2",
      "MemoryMcpCapabilitiesOutputV2",
      "MemoryMcpBindingInputV2",
      "MemoryMcpBindingOutputV2",
    ]) {
      expect(definitions).not.toHaveProperty(retired);
    }
  });

});

describe("RFC 8785 canonical JSON", () => {
  it("sorts object keys recursively and preserves array order", () => {
    expect(canonicalizeJson({ z: [3, { b: 2, a: 1 }], a: "x" })).toBe('{"a":"x","z":[3,{"a":1,"b":2}]}');
  });

  it("normalizes negative zero and produces stable SHA-256 digests", () => {
    expect(canonicalizeJson({ n: -0 })).toBe('{"n":0}');
    expect(canonicalJsonSha256({ b: 2, a: 1 })).toBe(
      "sha256:43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777",
    );
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("rejects non-JSON and non-finite values", () => {
    expect(() => canonicalizeJson({ value: undefined })).toThrow(TypeError);
    expect(() => canonicalizeJson({ value: Number.NaN })).toThrow(TypeError);
  });
});
