import type { Task } from "../../types.js";

/**
 * Real EMC PR replayed as an eval task.
 *
 * Provenance:
 *   Repo:    adobecom/EMC (local: /Users/rkhan/emcV2/EMC)
 *   PR:      #122 — "fix(rte): cleaner Quill HTML, semantic lists, NBSP normalization"
 *   Parent:  f787c7535b5e1dc133f69137baa1cd1da2a38b17
 *   Merge:   704fb110ac867350e26a3207148b590ad5c6b2a7
 *
 * Why this PR was chosen (off-scope / negative control):
 *   - The fix is purely Quill-2 library knowledge: replace `root.innerHTML`
 *     with `getSemanticHTML()`, narrow the `formats` whitelist, and load
 *     content via `clipboard.convert` + `setContents` instead of raw
 *     innerHTML assignment. Nothing in the org knowledge graph or any pod
 *     living doc encodes Quill internals.
 *   - Expected behaviour: PIM-arm and control-arm should perform similarly.
 *     If the PIM arm wins materially, the KG is hallucinating relevance;
 *     if it loses materially, KG injection is hurting unrelated tasks.
 */

const SOURCE_FILE = `import React, { useEffect, useRef } from 'react'
import { Text } from '@react-spectrum/s2'
import 'quill/dist/quill.snow.css'

interface RichTextEditorProps {
  label: string
  value: string
  onChange: (value: string) => void
  isRequired?: boolean
  height?: string
  description?: string
}

export const RichTextEditor: React.FC<RichTextEditorProps> = ({
  label,
  value,
  onChange,
  isRequired = false,
  height = '300px',
  description
}) => {
  const editorRef = useRef<any>(null)
  const quillRef = useRef<any>(null)
  const isUpdatingRef = useRef(false)
  const valueRef = useRef(value)
  const onChangeRef = useRef(onChange)

  useEffect(() => { valueRef.current = value }, [value])
  useEffect(() => { onChangeRef.current = onChange }, [onChange])

  useEffect(() => {
    const loadQuill = async () => {
      if (typeof window !== 'undefined' && !quillRef.current) {
        try {
          const Quill = (await import('quill')).default

          if (editorRef.current && !quillRef.current) {
            quillRef.current = new Quill(editorRef.current, {
              theme: 'snow',
              modules: {
                toolbar: [
                  ['bold', 'italic', 'underline', 'strike'],
                  [{ 'list': 'ordered' }, { 'list': 'bullet' }],
                  [{ 'align': [] }],
                  ['link'],
                  ['clean']
                ]
              },
              placeholder: \`Enter \${label.toLowerCase()}...\`
            })

            // Set initial value
            if (valueRef.current) {
              isUpdatingRef.current = true
              quillRef.current.root.innerHTML = valueRef.current
              isUpdatingRef.current = false
            }

            quillRef.current.on('text-change', (_delta: any, _oldDelta: any, source: string) => {
              if (isUpdatingRef.current || source !== 'user') return
              const html = quillRef.current.root.innerHTML
              const normalizedHtml = html === '<p><br></p>' ? '' : html
              if (normalizedHtml !== valueRef.current) {
                onChangeRef.current(normalizedHtml)
              }
            })
          }
        } catch (error) {
          console.error('Failed to load Quill editor:', error)
        }
      }
    }
    loadQuill()
    return () => { if (quillRef.current) { quillRef.current = null } }
  }, [label])

  // Update editor content when value prop changes externally
  useEffect(() => {
    if (quillRef.current && quillRef.current.root.innerHTML !== value) {
      isUpdatingRef.current = true
      const currentSelection = quillRef.current.getSelection()
      quillRef.current.root.innerHTML = value || ''
      if (currentSelection) {
        quillRef.current.setSelection(currentSelection)
      }
      isUpdatingRef.current = false
    }
  }, [value])
`;

const ISSUE_TEXT = `fix(rte): cleaner Quill HTML, semantic lists, NBSP normalization

Improve RichTextEditor (Quill 2) so stored HTML is cleaner and more portable
for event copy and APIs:

- Semantic export: bullet/ordered lists should serialize as plain <ul>/<ol>,
  not Quill 2's internal <ol data-list="..."> markup.
- Format whitelist: restrict to toolbar capabilities (bold, italic, underline,
  strike, list, indent, align, link) so pasted content cannot retain color,
  background, font, size, etc.
- Load path: set content via Quill's clipboard conversion + setContents
  (controlled value sync, refs guard against re-apply loops / caret jumps),
  not raw innerHTML assignment.

Existing records keep prior HTML until edited and saved again; no bulk
migration. type-check must pass.`;

const GROUND_TRUTH_PATCH = `--- a/web-src/src/components/shared/RichTextEditor.tsx
+++ b/web-src/src/components/shared/RichTextEditor.tsx
@@ -1,7 +1,20 @@
 import React, { useEffect, useRef } from 'react'
 import { Text } from '@react-spectrum/s2'
+import type Delta from 'quill-delta'
 import 'quill/dist/quill.snow.css'

+/** Matches toolbar capabilities; omits color/background/font/size so paste cannot add them. */
+const RTE_FORMATS = [
+  'bold',
+  'italic',
+  'underline',
+  'strike',
+  'list',
+  'indent',
+  'align',
+  'link',
+] as const
+
 interface RichTextEditorProps {
@@ -99,41 +112,47 @@ export const RichTextEditor: React.FC<RichTextEditorProps> = ({
       if (typeof window !== 'undefined' && !quillRef.current) {
         try {
           const Quill = (await import('quill')).default
-
+          const silent = Quill.sources?.SILENT ?? 'silent'
+
           if (editorRef.current && !quillRef.current) {
             quillRef.current = new Quill(editorRef.current, {
               theme: 'snow',
+              formats: [...RTE_FORMATS],
               modules: {
                 toolbar: [
                   ['bold', 'italic', 'underline', 'strike'],
                   [{ list: 'ordered' }, { list: 'bullet' }],
                   [{ align: [] }],
                   ['link'],
                   ['clean'],
                 ],
               },
               placeholder: \`Enter \${label.toLowerCase()}...\`,
             })
-
-            // Set initial value
-            if (valueRef.current) {
-              isUpdatingRef.current = true
-              quillRef.current.root.innerHTML = valueRef.current
-              isUpdatingRef.current = false
-            }
-
+
+            const initial = valueRef.current ?? ''
+            const trimmed = initial.trim()
+            isUpdatingRef.current = true
+            if (!trimmed) {
+              quillRef.current.setText('', silent)
+            } else {
+              const delta = quillRef.current.clipboard.convert({ html: trimmed, text: '' })
+              quillRef.current.setContents(delta, silent)
+            }
+            isUpdatingRef.current = false
+
             quillRef.current.on('text-change', (_delta: any, _oldDelta: any, source: string) => {
               if (isUpdatingRef.current || source !== 'user') {
                 return
               }
-              const html = quillRef.current.root.innerHTML
-              const normalizedHtml = html === '<p><br></p>' ? '' : html
-              if (normalizedHtml !== valueRef.current) {
+              const normalizedHtml = quillRef.current.getText().trim()
+                ? quillRef.current.getSemanticHTML()
+                : ''
+              if (normalizedHtml !== (valueRef.current ?? '')) {
                 onChangeRef.current(normalizedHtml)
               }
             })
@@ -154,16 +173,21 @@ export const RichTextEditor: React.FC<RichTextEditorProps> = ({
   useEffect(() => {
-    if (quillRef.current && quillRef.current.root.innerHTML !== value) {
-      isUpdatingRef.current = true
-      const currentSelection = quillRef.current.getSelection()
-      quillRef.current.root.innerHTML = value || ''
-      if (currentSelection) {
-        quillRef.current.setSelection(currentSelection)
-      }
-      isUpdatingRef.current = false
+    const quill = quillRef.current
+    if (!quill) return
+    const next = (value ?? '').trim()
+    isUpdatingRef.current = true
+    const currentSelection = quill.getSelection()
+    if (!next) {
+      quill.setText('', 'silent')
+    } else {
+      const delta = quill.clipboard.convert({ html: next, text: '' })
+      quill.setContents(delta, 'silent')
+    }
+    if (currentSelection) {
+      quill.setSelection(currentSelection)
     }
+    isUpdatingRef.current = false
   }, [value])
`;

export const rteQuillSemanticHtml: Task = {
  id: "real-emc-rte-quill-semantic-html",
  type: "content",
  // pod-emc-configs is the least-wrong choice: the org KG has no Quill
  // knowledge at all, so this is intentionally off-scope. We pick the configs
  // pod because the RTE renders config-driven event copy, but the fix itself
  // is library-internal.
  podId: "pod-emc-configs",
  asOf: "2026-04-07T14:55:25-07:00",
  tags: ["real-emc", "off-scope", "rich-text"],
  // Re-tiered to realistic-ticket (#8): dictated three-mechanism solution + pasted source removed.
  prompt: [
    "# Issue",
    "fix(rte): cleaner Quill HTML, semantic lists, NBSP normalization",
    "",
    "The RichTextEditor (Quill 2) stores HTML that isn't clean or portable for event",
    "copy and downstream APIs:",
    "- Bulleted/ordered lists serialize as Quill's internal list markup rather than",
    "  plain <ul>/<ol>.",
    "- Pasted content can smuggle in styling (color, background, font, size) that the",
    "  toolbar doesn't even expose.",
    "- Loading existing content occasionally causes caret jumps / re-apply loops.",
    "",
    "Make stored HTML semantic and restricted to the toolbar's capabilities, and load",
    "content in a way that doesn't fight the controlled value. Existing records keep",
    "their old HTML until edited and re-saved (no bulk migration). type-check must pass.",
    "",
    "The component is `web-src/src/components/shared/RichTextEditor.tsx`.",
    "",
    "# Output",
    "Return ONLY a unified diff (--- / +++ / @@) against the RichTextEditor component. No prose, no full-file rewrite.",
  ].join("\n"),
  expectedSignals: ["getSemanticHTML", "clipboard.convert", "setContents", "formats"],
  kgExpectations: {
    requiredFacts: [
      "Quill",
      "getSemanticHTML",
      "clipboard.convert",
      "formats",
    ],
    requiredSymbols: ["getSemanticHTML", "setContents"],
  },
  groundTruth: {
    output: GROUND_TRUTH_PATCH,
    note: "adobecom/EMC PR #122, merge SHA 704fb110. Parent file at f787c75.",
  },
  rubric: {
    id: "real-emc-rte-quill-semantic-html-v1",
    criteria: [
      {
        id: "uses_semantic_export",
        description:
          "Does the patch replace `quillRef.current.root.innerHTML` reads with `getSemanticHTML()` so lists serialize as plain <ul>/<ol> rather than Quill 2's internal <ol data-list=\"...\"> markup? Score 0-5: 0=still reads innerHTML, 5=fully on getSemanticHTML.",
        scale: "0-5",
        weight: 2,
      },
      {
        id: "restricts_formats_whitelist",
        description:
          "Does the patch add a `formats` array to the Quill constructor narrowed to the toolbar capabilities (bold, italic, underline, strike, list, indent, align, link) and omit color/background/font/size? Score 0-5.",
        scale: "0-5",
        weight: 1.5,
      },
      {
        id: "replaces_innerhtml_load_path",
        description:
          "Does the load path (both initial and the value-sync useEffect) stop assigning to `root.innerHTML` and instead build a delta via `clipboard.convert({ html, text })` and apply it with `setContents`? Score 0-5.",
        scale: "0-5",
        weight: 1.5,
      },
      {
        id: "matches_ground_truth_intent",
        description:
          "Compared to the reference patch, does the agent's diff achieve the same effect (semantic export + formats whitelist + clipboard.convert/setContents load path) regardless of exact formatting? Score 0-5.",
        scale: "0-5",
        weight: 2,
      },
      {
        id: "valid_unified_diff",
        description:
          "Is the output a parseable unified diff with --- / +++ / @@ headers and proper +/- prefixes (not prose, not a full-file rewrite)? Boolean.",
        scale: "boolean",
        weight: 1,
      },
    ],
  },
};
