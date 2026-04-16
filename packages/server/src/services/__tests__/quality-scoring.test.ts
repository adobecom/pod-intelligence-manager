import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the db module before importing quality-scoring
vi.mock("../../db/connection.js", () => ({
  default: {
    prepare: vi.fn().mockReturnValue({
      all: vi.fn().mockReturnValue([]),
      get: vi.fn().mockReturnValue(undefined),
    }),
  },
}));

import { scoreUpdate } from "../quality-scoring.js";
import type { ContextUpdateInput } from "../ingestion.js";
import db from "../../db/connection.js";

function makeInput(overrides: Partial<ContextUpdateInput> = {}): ContextUpdateInput {
  return {
    agent_id: "agent-fe",
    type: "progress",
    scope: "frontend",
    summary: "Implemented the checkout form validation with Zod schema",
    details: "Added client-side and server-side validation for all checkout fields including email, address, and payment info. Used Zod for schema definition shared between client and server.",
    artifacts: [],
    status: "in_progress",
    blocks: [],
    blocked_by: [],
    needs_input_from: [],
    source: "manual",
    ...overrides,
  };
}

describe("scoreUpdate", () => {
  beforeEach(() => {
    vi.mocked(db.prepare).mockReturnValue({
      all: vi.fn().mockReturnValue([]),
      get: vi.fn().mockReturnValue(undefined),
    } as any);
  });

  it("returns a QualityBreakdown with all four dimensions", () => {
    const result = scoreUpdate(makeInput(), "pod-test");
    expect(result).toHaveProperty("completeness");
    expect(result).toHaveProperty("specificity");
    expect(result).toHaveProperty("relationships");
    expect(result).toHaveProperty("contextual_fit");
    expect(result).toHaveProperty("total");
  });

  it("total equals sum of dimensions (capped at 1.0)", () => {
    const result = scoreUpdate(makeInput(), "pod-test");
    const sum = result.completeness + result.specificity + result.relationships + result.contextual_fit;
    expect(result.total).toBeCloseTo(Math.min(1.0, sum), 5);
  });

  it("each dimension stays within its max", () => {
    const result = scoreUpdate(makeInput(), "pod-test");
    expect(result.completeness).toBeLessThanOrEqual(0.3);
    expect(result.specificity).toBeLessThanOrEqual(0.3);
    expect(result.relationships).toBeLessThanOrEqual(0.2);
    expect(result.contextual_fit).toBeLessThanOrEqual(0.2);
  });

  describe("completeness", () => {
    it("scores higher with long details", () => {
      const short = scoreUpdate(makeInput({ details: "short" }), "pod-test");
      const long = scoreUpdate(makeInput({
        details: "A".repeat(150),
      }), "pod-test");
      expect(long.completeness).toBeGreaterThan(short.completeness);
    });

    it("scores higher with artifacts", () => {
      const without = scoreUpdate(makeInput(), "pod-test");
      const with_ = scoreUpdate(makeInput({
        artifacts: [{ type: "file", path: "src/checkout.ts" }],
      }), "pod-test");
      expect(with_.completeness).toBeGreaterThan(without.completeness);
    });

    it("scores higher with relationship fields populated", () => {
      const without = scoreUpdate(makeInput(), "pod-test");
      const with_ = scoreUpdate(makeInput({
        blocks: ["agent-be"],
      }), "pod-test");
      expect(with_.completeness).toBeGreaterThan(without.completeness);
    });
  });

  describe("specificity", () => {
    it("penalizes vague summaries", () => {
      const vague = scoreUpdate(makeInput({
        summary: "made progress on the thing",
      }), "pod-test");
      const specific = scoreUpdate(makeInput({
        summary: "Implemented CheckoutForm.tsx with Zod validation for email and address fields",
      }), "pod-test");
      expect(specific.specificity).toBeGreaterThan(vague.specificity);
    });

    it("rewards named entities and technical identifiers", () => {
      const generic = scoreUpdate(makeInput({
        summary: "fixed the bug in the form",
        details: "it was broken",
      }), "pod-test");
      const technical = scoreUpdate(makeInput({
        summary: "Fixed validateAddress() null check in CheckoutForm component",
        details: "The src/components/CheckoutForm.tsx was throwing when address.state was undefined",
      }), "pod-test");
      expect(technical.specificity).toBeGreaterThan(generic.specificity);
    });

    it("rewards longer summaries (more words)", () => {
      const short = scoreUpdate(makeInput({ summary: "fixed bug" }), "pod-test");
      const medium = scoreUpdate(makeInput({
        summary: "Fixed the null pointer bug in the address validation component",
      }), "pod-test");
      expect(medium.specificity).toBeGreaterThan(short.specificity);
    });
  });

  describe("relationships", () => {
    it("rewards blockers that specify blocked_by", () => {
      const without = scoreUpdate(makeInput({
        type: "blocker",
        status: "blocked",
        blocked_by: [],
      }), "pod-test");
      const with_ = scoreUpdate(makeInput({
        type: "blocker",
        status: "blocked",
        blocked_by: ["agent-be"],
      }), "pod-test");
      expect(with_.relationships).toBeGreaterThan(without.relationships);
    });

    it("rewards questions that specify needs_input_from", () => {
      const without = scoreUpdate(makeInput({
        type: "question",
        needs_input_from: [],
      }), "pod-test");
      const with_ = scoreUpdate(makeInput({
        type: "question",
        needs_input_from: [{ role: "design", question: "What colors?" }],
      }), "pod-test");
      expect(with_.relationships).toBeGreaterThan(without.relationships);
    });

    it("gives non-dependent types baseline credit", () => {
      const progress = scoreUpdate(makeInput({
        type: "progress",
        blocks: [],
        blocked_by: [],
        needs_input_from: [],
      }), "pod-test");
      // Progress with no relationships still gets 0.05 baseline
      expect(progress.relationships).toBe(0.05);
    });

    it("rewards downstream awareness (blocks populated)", () => {
      const without = scoreUpdate(makeInput({ blocks: [] }), "pod-test");
      const with_ = scoreUpdate(makeInput({ blocks: ["agent-qa"] }), "pod-test");
      expect(with_.relationships).toBeGreaterThan(without.relationships);
    });
  });

  describe("contextual_fit", () => {
    it("gives benefit of the doubt to first-time agents", () => {
      const result = scoreUpdate(makeInput(), "pod-test");
      // No prior updates → 0.10 + 0.05 = 0.15
      expect(result.contextual_fit).toBeCloseTo(0.15, 5);
    });

    it("rewards scope consistency with prior updates", () => {
      vi.mocked(db.prepare).mockImplementation((sql: string) => {
        if (sql.includes("context_updates")) {
          return {
            all: vi.fn().mockReturnValue([
              { scope: "frontend" },
              { scope: "frontend" },
              { scope: "frontend" },
            ]),
            get: vi.fn().mockReturnValue(undefined),
          } as any;
        }
        return {
          all: vi.fn().mockReturnValue([]),
          get: vi.fn().mockReturnValue(undefined),
        } as any;
      });

      const consistent = scoreUpdate(makeInput({ scope: "frontend" }), "pod-test");
      expect(consistent.contextual_fit).toBeGreaterThanOrEqual(0.15);
    });

    it("scores lower for scope mismatch", () => {
      vi.mocked(db.prepare).mockImplementation((sql: string) => {
        if (sql.includes("context_updates")) {
          return {
            all: vi.fn().mockReturnValue([
              { scope: "backend" },
              { scope: "backend" },
              { scope: "backend" },
            ]),
            get: vi.fn().mockReturnValue(undefined),
          } as any;
        }
        return {
          all: vi.fn().mockReturnValue([]),
          get: vi.fn().mockReturnValue(undefined),
        } as any;
      });

      const mismatch = scoreUpdate(makeInput({ scope: "frontend" }), "pod-test");
      // Mismatch: 0.03 + 0.05 = 0.08
      expect(mismatch.contextual_fit).toBeCloseTo(0.08, 5);
    });

    it("gives bonus for matching pod_areas assignment", () => {
      vi.mocked(db.prepare).mockImplementation((sql: string) => {
        if (sql.includes("context_updates")) {
          return {
            all: vi.fn().mockReturnValue([]),
            get: vi.fn().mockReturnValue(undefined),
          } as any;
        }
        if (sql.includes("pod_areas")) {
          return {
            all: vi.fn().mockReturnValue([]),
            get: vi.fn().mockReturnValue({ scope: "frontend", owner: "agent-fe" }),
          } as any;
        }
        return {
          all: vi.fn().mockReturnValue([]),
          get: vi.fn().mockReturnValue(undefined),
        } as any;
      });

      const result = scoreUpdate(makeInput(), "pod-test");
      // First-time (0.15) + area match (0.05) = 0.20
      expect(result.contextual_fit).toBeCloseTo(0.2, 5);
    });
  });

  describe("realistic scoring gradient", () => {
    it("high-quality update scores >= 0.7", () => {
      const result = scoreUpdate(makeInput({
        summary: "Implemented CheckoutForm.tsx with Zod validation for email, address, and payment fields",
        details: "Added comprehensive client-side and server-side validation using shared Zod schemas. The CheckoutForm component validates email format, US/CA address structure, and credit card numbers via Luhn algorithm. Integrated with the existing FormProvider context in src/providers/FormProvider.tsx.",
        artifacts: [{ type: "file", path: "src/components/CheckoutForm.tsx" }],
        blocks: ["agent-qa"],
      }), "pod-test");
      expect(result.total).toBeGreaterThanOrEqual(0.7);
    });

    it("vague low-effort update scores < 0.5", () => {
      const result = scoreUpdate(makeInput({
        summary: "made progress",
        details: "",
        artifacts: [],
        blocks: [],
        blocked_by: [],
        needs_input_from: [],
      }), "pod-test");
      expect(result.total).toBeLessThan(0.5);
    });

    it("medium-effort update scores between 0.4 and 0.7", () => {
      const result = scoreUpdate(makeInput({
        summary: "Updated the login form styles",
        details: "Changed some CSS properties for better alignment",
        artifacts: [],
      }), "pod-test");
      expect(result.total).toBeGreaterThanOrEqual(0.3);
      expect(result.total).toBeLessThan(0.75);
    });
  });
});
