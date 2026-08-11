import {
  MEMORY_CONTRACT_FIXTURES,
  MEMORY_CONTRACT_SCHEMA,
  type MemoryContractName,
  type MemoryContractTypeMap,
} from "../types/memory-contracts.generated.js";
import {
  MEMORY_CONTRACT_FIXTURES_V2,
  MEMORY_CONTRACT_SCHEMA_V2,
  type MemoryContractNameV2,
  type MemoryContractTypeMapV2,
} from "../types/memory-contracts-v2.generated.js";

export {
  MEMORY_CONTRACT_FIXTURES,
  MEMORY_CONTRACT_SCHEMA,
  MEMORY_CONTRACT_FIXTURES_V2,
  MEMORY_CONTRACT_SCHEMA_V2,
};

export type {
  MemoryContractName,
  MemoryContractNameV2,
  MemoryContractTypeMap,
  MemoryContractTypeMapV2,
};

export interface MemoryContractIssue {
  path: string;
  reason: string;
}

export class MemoryContractValidationError extends Error {
  readonly issues: MemoryContractIssue[];

  constructor(
    contract: MemoryContractName | MemoryContractNameV2,
    issues: MemoryContractIssue[],
  ) {
    super(`Payload does not match ${contract}`);
    this.name = "MemoryContractValidationError";
    this.issues = issues;
  }
}

type SchemaNode = Record<string, unknown>;
type MemoryContractSchema = {
  readonly $defs: Readonly<Record<string, unknown>>;
};

/**
 * Memory contracts are request-boundary JSON. Keep these limits comfortably
 * above every published fixture while preventing recursive schema validation
 * (and later canonical JSON hashing) from consuming an attacker-controlled
 * call stack or an unbounded number of nodes.
 */
export const MEMORY_CONTRACT_MAX_DEPTH = 64;
export const MEMORY_CONTRACT_MAX_NODES = 50_000;

function pointer(path: Array<string | number>): string {
  if (path.length === 0) return "/";
  return `/${path.map((part) => String(part).replaceAll("~", "~0").replaceAll("/", "~1")).join("/")}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function structureIssue(value: unknown): MemoryContractIssue | null {
  const stack: Array<{ value: unknown; path: Array<string | number>; depth: number }> = [
    { value, path: [], depth: 0 },
  ];
  const seen = new WeakSet<object>();
  let nodes = 0;

  while (stack.length > 0) {
    const current = stack.pop()!;
    nodes++;
    if (nodes > MEMORY_CONTRACT_MAX_NODES) {
      return {
        path: "/",
        reason: `must contain at most ${MEMORY_CONTRACT_MAX_NODES} structural nodes`,
      };
    }
    if (current.depth > MEMORY_CONTRACT_MAX_DEPTH) {
      return {
        path: pointer(current.path),
        reason: `must not exceed a structural depth of ${MEMORY_CONTRACT_MAX_DEPTH}`,
      };
    }
    if (typeof current.value !== "object" || current.value === null) continue;
    if (seen.has(current.value)) {
      return { path: pointer(current.path), reason: "must be an acyclic JSON value" };
    }
    seen.add(current.value);

    if (Array.isArray(current.value)) {
      for (let index = current.value.length - 1; index >= 0; index--) {
        stack.push({
          value: current.value[index],
          path: [...current.path, index],
          depth: current.depth + 1,
        });
      }
      continue;
    }

    const record = current.value as Record<string, unknown>;
    const names = Object.keys(record);
    for (let index = names.length - 1; index >= 0; index--) {
      const name = names[index]!;
      stack.push({
        value: record[name],
        path: [...current.path, name],
        depth: current.depth + 1,
      });
    }
  }

  return null;
}

function schemaTypeMatches(type: string, value: unknown): boolean {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return isObject(value);
  if (type === "integer") return typeof value === "number" && Number.isSafeInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === type;
}

function typeLabel(type: unknown): string {
  return Array.isArray(type) ? type.join(" or ") : String(type);
}

function resolveReference(schema: MemoryContractSchema, ref: string): SchemaNode {
  const prefix = "#/$defs/";
  if (!ref.startsWith(prefix)) throw new Error(`Unsupported memory schema reference: ${ref}`);
  const name = ref.slice(prefix.length);
  const resolved = schema.$defs[name] as SchemaNode | undefined;
  if (!resolved) throw new Error(`Unknown memory schema reference: ${ref}`);
  return resolved;
}

function validateNode(
  schema: MemoryContractSchema,
  node: SchemaNode,
  value: unknown,
  path: Array<string | number>,
): MemoryContractIssue[] {
  if (typeof node.$ref === "string") {
    return validateNode(schema, resolveReference(schema, node.$ref), value, path);
  }

  if (Array.isArray(node.allOf)) {
    return (node.allOf as SchemaNode[])
      .flatMap((candidate) => validateNode(schema, candidate, value, path));
  }

  if (Array.isArray(node.oneOf)) {
    const attempts = (node.oneOf as SchemaNode[])
      .map((candidate) => validateNode(schema, candidate, value, path));
    const matches = attempts.filter((issues) => issues.length === 0);
    return matches.length === 1
      ? []
      : [{ path: pointer(path), reason: matches.length === 0 ? "does not match any allowed shape" : "matches more than one allowed shape" }];
  }

  if (Array.isArray(node.anyOf)) {
    const matched = (node.anyOf as SchemaNode[])
      .some((candidate) => validateNode(schema, candidate, value, path).length === 0);
    return matched ? [] : [{ path: pointer(path), reason: "does not match any allowed shape" }];
  }

  if (Object.prototype.hasOwnProperty.call(node, "const") && !Object.is(value, node.const)) {
    return [{ path: pointer(path), reason: `must equal ${JSON.stringify(node.const)}` }];
  }

  if (Array.isArray(node.enum) && !(node.enum as unknown[]).some((candidate) => Object.is(candidate, value))) {
    return [{ path: pointer(path), reason: "must be one of the published enum values" }];
  }

  const allowedTypes = Array.isArray(node.type) ? node.type : node.type ? [node.type] : [];
  if (allowedTypes.length > 0 && !(allowedTypes as string[]).some((type) => schemaTypeMatches(type, value))) {
    return [{ path: pointer(path), reason: `must be ${typeLabel(node.type)}` }];
  }

  if (value === null) return [];

  const issues: MemoryContractIssue[] = [];
  if (typeof value === "string") {
    if (typeof node.minLength === "number" && value.length < node.minLength) issues.push({ path: pointer(path), reason: `must contain at least ${node.minLength} characters` });
    if (typeof node.maxLength === "number" && value.length > node.maxLength) issues.push({ path: pointer(path), reason: `must contain at most ${node.maxLength} characters` });
    if (typeof node.pattern === "string" && !new RegExp(node.pattern).test(value)) issues.push({ path: pointer(path), reason: "has an invalid normalized format" });
    if (node.format === "date-time" && !Number.isFinite(Date.parse(value))) issues.push({ path: pointer(path), reason: "must be an RFC 3339 timestamp" });
    if (node.format === "uri") {
      try {
        const url = new URL(value);
        if (!url.protocol) throw new Error("missing protocol");
      } catch {
        issues.push({ path: pointer(path), reason: "must be an absolute URI" });
      }
    }
  }

  if (typeof value === "number") {
    if (typeof node.minimum === "number" && value < node.minimum) issues.push({ path: pointer(path), reason: `must be at least ${node.minimum}` });
    if (typeof node.maximum === "number" && value > node.maximum) issues.push({ path: pointer(path), reason: `must be at most ${node.maximum}` });
  }

  if (Array.isArray(value)) {
    if (typeof node.minItems === "number" && value.length < node.minItems) issues.push({ path: pointer(path), reason: `must contain at least ${node.minItems} items` });
    if (typeof node.maxItems === "number" && value.length > node.maxItems) issues.push({ path: pointer(path), reason: `must contain at most ${node.maxItems} items` });
    if (node.uniqueItems === true) {
      const seen = new Set(value.map((item) => JSON.stringify(item)));
      if (seen.size !== value.length) issues.push({ path: pointer(path), reason: "must not contain duplicate items" });
    }
    if (isObject(node.items)) {
      value.forEach((item, index) => {
        issues.push(...validateNode(schema, node.items as SchemaNode, item, [...path, index]));
      });
    }
  }

  if (isObject(value)) {
    const properties = isObject(node.properties) ? node.properties as Record<string, SchemaNode> : {};
    const required = Array.isArray(node.required) ? node.required as string[] : [];
    for (const name of required) {
      if (!Object.prototype.hasOwnProperty.call(value, name)) issues.push({ path: pointer([...path, name]), reason: "is required" });
    }
    if (typeof node.maxProperties === "number" && Object.keys(value).length > node.maxProperties) {
      issues.push({ path: pointer(path), reason: `must contain at most ${node.maxProperties} properties` });
    }
    for (const [name, child] of Object.entries(value)) {
      if (Object.prototype.hasOwnProperty.call(properties, name)) {
        issues.push(...validateNode(schema, properties[name]!, child, [...path, name]));
      } else if (node.additionalProperties === false) {
        issues.push({ path: pointer([...path, name]), reason: "unknown field" });
      } else if (isObject(node.additionalProperties)) {
        issues.push(...validateNode(
          schema,
          node.additionalProperties as SchemaNode,
          child,
          [...path, name],
        ));
      }
    }
  }

  return issues;
}

function contractIssues(
  schema: MemoryContractSchema,
  contract: string,
  value: unknown,
): MemoryContractIssue[] {
  const definition = schema.$defs[contract] as SchemaNode | undefined;
  if (!definition) throw new Error(`Unknown memory contract: ${contract}`);
  const inputStructureIssue = structureIssue(value);
  if (inputStructureIssue) return [inputStructureIssue];
  return validateNode(schema, definition, value, []);
}

export function memoryContractIssues<N extends MemoryContractName>(
  contract: N,
  value: unknown,
): MemoryContractIssue[] {
  return contractIssues(MEMORY_CONTRACT_SCHEMA, contract, value);
}

export function parseMemoryContract<N extends MemoryContractName>(
  contract: N,
  value: unknown,
): MemoryContractTypeMap[N] {
  const issues = memoryContractIssues(contract, value);
  if (issues.length > 0) throw new MemoryContractValidationError(contract, issues);
  return value as MemoryContractTypeMap[N];
}

export function memoryContractV2Issues<N extends MemoryContractNameV2>(
  contract: N,
  value: unknown,
): MemoryContractIssue[] {
  return contractIssues(MEMORY_CONTRACT_SCHEMA_V2, contract, value);
}

export function parseMemoryContractV2<N extends MemoryContractNameV2>(
  contract: N,
  value: unknown,
): MemoryContractTypeMapV2[N] {
  const issues = memoryContractV2Issues(contract, value);
  if (issues.length > 0) throw new MemoryContractValidationError(contract, issues);
  return value as MemoryContractTypeMapV2[N];
}
