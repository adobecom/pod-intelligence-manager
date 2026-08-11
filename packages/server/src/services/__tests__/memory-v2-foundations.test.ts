import { describe, expect, it } from "vitest";
import { scanMemoryV2Input } from "../memory-v2-input-safety.js";
describe("v2 input-safety foundations", () => {
  it("rejects hidden reasoning, secrets, and focused personal data before persistence", () => {
    expect(scanMemoryV2Input({ content: { hidden_reasoning: "private" } })).toMatchObject({
      clean: false,
      reason: "hidden_reasoning",
      path: "/content/hidden_reasoning",
    });
    expect(scanMemoryV2Input({ summary: "SSN 123-45-6789" })).toMatchObject({
      clean: false,
      reason: "disallowed_personal_data",
    });
    expect(scanMemoryV2Input({
      token: "ghp_abcdefghijklmnopqrstuvwxyz123456",
    })).toMatchObject({
      clean: false,
      reason: "secret_shaped_content",
    });
  });

  it("does not apply a whole-body Luhn scanner to ordinary content", () => {
    const luhnShapedDigest = "a84ed0a43c9148b70ef9cb1fe3035475616549c0969336637decb39040df7997";
    expect(scanMemoryV2Input({ digest: `sha256:${luhnShapedDigest}` }))
      .toEqual({ clean: true });
    expect(scanMemoryV2Input({ base_sha: luhnShapedDigest }))
      .toEqual({ clean: true });
    expect(scanMemoryV2Input({
      note: "Card 4111111111111111",
    })).toEqual({ clean: true });
    expect(scanMemoryV2Input({
      event_id: "1754870400026",
    })).toEqual({ clean: true });
  });
});
