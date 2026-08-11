import { scanForSecrets } from "./secret-scan.js";

export interface MemoryV2InputSafetyResult {
  clean: boolean;
  reason?: "secret_shaped_content" | "hidden_reasoning" | "disallowed_personal_data";
  path?: string;
}

const HIDDEN_REASONING_FIELDS = new Set([
  "chain_of_thought",
  "chainofthought",
  "hidden_reasoning",
  "private_reasoning",
  "scratchpad",
]);

const DISALLOWED_PERSONAL_DATA = [
  /\b\d{3}-\d{2}-\d{4}\b/,
];

function escapedPointer(parts: Array<string | number>): string {
  if (parts.length === 0) return "/";
  return `/${parts.map((part) => String(part).replaceAll("~", "~0").replaceAll("/", "~1")).join("/")}`;
}

/** Performs deterministic pre-persistence checks. It intentionally rejects
 * only high-confidence personal-data patterns; policy-specific classification
 * remains a separate admission control. */
export function scanMemoryV2Input(value: unknown): MemoryV2InputSafetyResult {
  const serialized = JSON.stringify(value);
  if (!scanForSecrets(serialized).clean) {
    return { clean: false, reason: "secret_shaped_content", path: "/" };
  }

  const stack: Array<{ value: unknown; path: Array<string | number> }> = [
    { value, path: [] },
  ];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (typeof current.value === "string") {
      const text = current.value;
      if (DISALLOWED_PERSONAL_DATA.some((pattern) => pattern.test(text))) {
        return {
          clean: false,
          reason: "disallowed_personal_data",
          path: escapedPointer(current.path),
        };
      }
      continue;
    }
    if (!current.value || typeof current.value !== "object") continue;
    if (Array.isArray(current.value)) {
      current.value.forEach((child, index) => stack.push({
        value: child,
        path: [...current.path, index],
      }));
      continue;
    }
    for (const [name, child] of Object.entries(current.value)) {
      if (HIDDEN_REASONING_FIELDS.has(name.toLowerCase())) {
        return {
          clean: false,
          reason: "hidden_reasoning",
          path: escapedPointer([...current.path, name]),
        };
      }
      stack.push({ value: child, path: [...current.path, name] });
    }
  }
  return { clean: true };
}
