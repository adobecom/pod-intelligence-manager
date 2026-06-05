import type { Task } from "../../types.js";

export const synthRegistrationLocaleOverlay: Task = {
  id: "synth-registration-locale-overlay",
  type: "code",
  podId: "pod-emc-configs",
  stratum: "S4",
  tags: ["synthetic", "context-stress", "pim-needed", "configs", "registration", "localization"],
  prompt: [
    "Implement `resolveFieldForLocale(field: Record<string, any>, locale: string): Record<string, any>` for the RSVP FormRenderer.",
    "",
    "Field schemas can include a `localizations` object. Resolve the field for the requested locale using the EMC registration-config convention.",
    "Return a new object suitable for rendering; do not mutate the input field.",
    "",
    "Export the function as a named export `resolveFieldForLocale`.",
  ].join("\n"),
  expectedSignals: ["localizations", "label", "placeholder", "validation", "fallback"],
  tests: [
    {
      name: "overlays only label and placeholder for the requested locale",
      body: [
        "const field = { id: 'company', type: 'text', label: 'Company', placeholder: 'Company name', required: true, validation: { maxLength: 80 }, order: 3, localizations: { 'fr-FR': { label: 'Entreprise', placeholder: \"Nom de l'entreprise\", required: false, validation: { maxLength: 5 }, type: 'select' } } };",
        "const out = mod.resolveFieldForLocale(field, 'fr-FR');",
        "assert.equal(out.label, 'Entreprise');",
        "assert.equal(out.placeholder, \"Nom de l'entreprise\");",
        "assert.equal(out.type, 'text');",
        "assert.equal(out.required, true);",
        "assert.deepEqual(out.validation, { maxLength: 80 });",
        "assert.equal(out.order, 3);",
      ].join("\n"),
    },
    {
      name: "falls back to base strings when locale or localized field is absent",
      body: [
        "const field = { id: 'email', type: 'email', label: 'Email', placeholder: 'name@example.com', localizations: { 'ja-JP': { label: 'メール' } } };",
        "assert.equal(mod.resolveFieldForLocale(field, 'de-DE').label, 'Email');",
        "const ja = mod.resolveFieldForLocale(field, 'ja-JP');",
        "assert.equal(ja.label, 'メール');",
        "assert.equal(ja.placeholder, 'name@example.com');",
      ].join("\n"),
    },
    {
      name: "removes the localizations transport block from render output and keeps input unchanged",
      body: [
        "const field = { id: 'name', label: 'Name', placeholder: 'Full name', localizations: { 'es-ES': { label: 'Nombre' } } };",
        "const out = mod.resolveFieldForLocale(field, 'es-ES');",
        "assert.equal(Object.prototype.hasOwnProperty.call(out, 'localizations'), false);",
        "assert.equal(Object.prototype.hasOwnProperty.call(field, 'localizations'), true);",
      ].join("\n"),
    },
  ],
};
