import type { Task } from "../types.js";

export const formLocalization: Task = {
  id: "form-localization",
  type: "code",
  podId: "pod-emc-configs",
  tags: ["registration", "forms"],
  prompt: [
    "Implement `renderField(base: { id: string; type: string; label: string; placeholder?: string; required?: boolean }, locale: string, overlays: Record<string, { label?: string; placeholder?: string }>): { id: string; type: string; label: string; placeholder?: string; required?: boolean }`.",
    "",
    "Behavior:",
    "- Start with `base` as the field definition (field type, validation, ordering live in the base).",
    "- If `overlays[locale]` exists, override `label` and `placeholder` on the returned field with the overlay's values, but only for the keys actually present in the overlay (an overlay may have `label` only, or `placeholder` only).",
    "- Do not let an overlay change anything other than `label` and `placeholder`. The overlay must NOT change `id`, `type`, or `required`.",
    "- If the overlay for the requested locale is missing, fall back to the base.",
    "- Do not mutate the inputs.",
    "",
    "Export the function as a named export `renderField`.",
  ].join("\n"),
  expectedSignals: ["overlay", "locale", "FormRenderer", "fallback"],
  tests: [
    {
      name: "applies label and placeholder overrides for the matching locale",
      body: [
        "const base = { id: 'name', type: 'text', label: 'Full name', placeholder: 'Jane Doe', required: true };",
        "const overlays = { 'fr-FR': { label: 'Nom complet', placeholder: 'Jeanne Dupont' } };",
        "const out = mod.renderField(base, 'fr-FR', overlays);",
        "assert.equal(out.label, 'Nom complet');",
        "assert.equal(out.placeholder, 'Jeanne Dupont');",
        "assert.equal(out.id, 'name');",
        "assert.equal(out.type, 'text');",
        "assert.equal(out.required, true);",
      ].join("\n"),
    },
    {
      name: "falls back to base when overlay for locale is missing",
      body: [
        "const base = { id: 'email', type: 'email', label: 'Email', placeholder: 'you@adobe.com' };",
        "const overlays = { 'fr-FR': { label: 'Courriel' } };",
        "const out = mod.renderField(base, 'ja-JP', overlays);",
        "assert.equal(out.label, 'Email');",
        "assert.equal(out.placeholder, 'you@adobe.com');",
      ].join("\n"),
    },
    {
      name: "overlay cannot change id, type, or required",
      body: [
        "const base = { id: 'phone', type: 'tel', label: 'Phone', required: false };",
        "const evilOverlay = { 'es-ES': { label: 'Teléfono', id: 'pwn', type: 'text', required: true } as any };",
        "const out = mod.renderField(base, 'es-ES', evilOverlay);",
        "assert.equal(out.id, 'phone', 'overlay must not change id');",
        "assert.equal(out.type, 'tel', 'overlay must not change type');",
        "assert.equal(out.required, false, 'overlay must not change required');",
        "assert.equal(out.label, 'Teléfono');",
      ].join("\n"),
    },
    {
      name: "partial overlay (label only) leaves base placeholder intact",
      body: [
        "const base = { id: 'company', type: 'text', label: 'Company', placeholder: 'Adobe' };",
        "const overlays = { 'fr-FR': { label: 'Entreprise' } };",
        "const out = mod.renderField(base, 'fr-FR', overlays);",
        "assert.equal(out.label, 'Entreprise');",
        "assert.equal(out.placeholder, 'Adobe');",
      ].join("\n"),
    },
  ],
};
