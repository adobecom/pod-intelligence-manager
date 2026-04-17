import { useEffect, useId, useRef } from "react";
import type { CSSProperties } from "react";
import Quill from "quill";
import TurndownService from "turndown";
import MarkdownIt from "markdown-it";
import { style } from "@react-spectrum/s2/style" with { type: "macro" };
import "quill/dist/quill.snow.css";
import "./MarkdownDetailsEditor.css";

const mdIt = new MarkdownIt({ html: true, linkify: true, breaks: true });

function markdownToHtml(src: string): string {
  const t = src.trim();
  if (!t) return "<p><br></p>";
  return mdIt.render(t);
}

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
});

const toolbarOptions = [
  [{ header: [1, 2, 3, false] }],
  ["bold", "italic", "underline", "strike"],
  [{ list: "ordered" }, { list: "bullet" }],
  ["blockquote", "code-block"],
  ["link"],
  ["clean"],
];

const field = style({ display: "flex", flexDirection: "column", gap: 8 });
const editorCard = style({
  borderRadius: "default",
  borderWidth: 1,
  borderStyle: "solid",
  borderColor: "gray-300",
  overflow: "hidden",
});

/**
 * WYSIWYG (Quill) editor; value/onChange use **Markdown** for APIs and ingestion.
 * Uses Quill directly (no react-quill) for React 19 compatibility — react-quill relies on findDOMNode.
 */
export function MarkdownDetailsEditor({
  label,
  value,
  onChange,
  minHeight = 220,
}: {
  label: string;
  value: string;
  onChange: (markdown: string) => void;
  minHeight?: number;
}) {
  const id = useId();
  const labelId = `${id}-label`;
  /** Holds toolbar + container — Snow inserts `.ql-toolbar` as a sibling before the editor node. */
  const wrapperRef = useRef<HTMLDivElement>(null);
  const quillRef = useRef<Quill | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const valueRef = useRef(value);
  valueRef.current = value;
  const textChangeHandlerRef = useRef<(() => void) | null>(null);
  const skipEmitRef = useRef(false);

  useEffect(() => {
    const wrap = wrapperRef.current;
    if (!wrap) return;

    wrap.innerHTML = "";
    const el = document.createElement("div");
    wrap.appendChild(el);

    const quill = new Quill(el, {
      theme: "snow",
      modules: { toolbar: toolbarOptions },
      placeholder: "Rich text; saved as Markdown for ingestion agents.",
    });
    quillRef.current = quill;

    const onTextChange = () => {
      if (skipEmitRef.current) return;
      const html = quill.root.innerHTML;
      const md = turndown.turndown(html).trim();
      // If markdown is unchanged vs controlled `value`, skip onChange + skipEmit.
      // Otherwise a trailing space (same trimmed md) can skip React re-render while
      // skipEmit stays true, silencing all further edits until remount.
      if (md === valueRef.current.trim()) return;
      skipEmitRef.current = true;
      onChangeRef.current(md);
    };
    textChangeHandlerRef.current = onTextChange;
    quill.on("text-change", onTextChange);

    return () => {
      quill.off("text-change", onTextChange);
      textChangeHandlerRef.current = null;
      quillRef.current = null;
      wrap.innerHTML = "";
    };
  }, []);

  useEffect(() => {
    const quill = quillRef.current;
    const handler = textChangeHandlerRef.current;
    if (!quill || !handler) return;

    if (skipEmitRef.current) {
      skipEmitRef.current = false;
      return;
    }

    quill.off("text-change", handler);
    quill.clipboard.dangerouslyPasteHTML(markdownToHtml(value), "silent");
    quill.on("text-change", handler);
  }, [value]);

  const varStyle = {
    "--md-details-min": `${minHeight}px`,
  } as CSSProperties;

  return (
    <div className={field} role="group" aria-labelledby={labelId}>
      <span id={labelId} style={{ fontSize: 14, fontWeight: 500 }}>
        {label}
      </span>
      <div
        ref={wrapperRef}
        className={`markdown-details-quill ${editorCard}`}
        style={varStyle}
      />
    </div>
  );
}
