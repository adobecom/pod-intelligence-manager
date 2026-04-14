import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Heading, ProgressCircle } from "@react-spectrum/s2";
import { style } from "@react-spectrum/s2/style" with { type: "macro" };
import Markdown from "react-markdown";
import * as api from "../../services/api";

const column = style({ display: "flex", flexDirection: "column", gap: 16 });

const loadingContainer = style({
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  height: 240,
});

export function LiveDocView() {
  const { podId } = useParams<{ podId: string }>();
  const [doc, setDoc] = useState<string | null>(null);

  useEffect(() => {
    if (podId) {
      api.getLivingDoc(podId).then(setDoc);
    }
  }, [podId]);

  if (doc === null) {
    return (
      <div className={loadingContainer}>
        <ProgressCircle aria-label="Loading..." isIndeterminate />
      </div>
    );
  }

  return (
    <div className={column}>
      <Heading level={2} styles={style({ marginY: 0 })}>
        Living Doc
      </Heading>
      <div
        style={{
          maxWidth: 720,
          lineHeight: 1.6,
          fontSize: 14,
        }}
      >
        <Markdown
          components={{
            h1: ({ children }) => (
              <h1 style={{ fontSize: 24, margin: "16px 0 8px" }}>{children}</h1>
            ),
            h2: ({ children }) => (
              <h2
                style={{
                  fontSize: 20,
                  margin: "14px 0 6px",
                  borderBottom: "1px solid var(--spectrum-gray-300)",
                  paddingBottom: 4,
                }}
              >
                {children}
              </h2>
            ),
            h3: ({ children }) => (
              <h3 style={{ fontSize: 16, margin: "12px 0 4px" }}>
                {children}
              </h3>
            ),
            p: ({ children }) => (
              <p style={{ margin: "8px 0" }}>{children}</p>
            ),
            table: ({ children }) => (
              <table
                style={{
                  borderCollapse: "collapse",
                  width: "100%",
                  margin: "8px 0",
                }}
              >
                {children}
              </table>
            ),
            th: ({ children }) => (
              <th
                style={{
                  textAlign: "left",
                  padding: "6px 12px",
                  borderBottom: "2px solid var(--spectrum-gray-400)",
                  fontSize: 13,
                  fontWeight: 600,
                }}
              >
                {children}
              </th>
            ),
            td: ({ children }) => (
              <td
                style={{
                  padding: "4px 12px",
                  borderBottom: "1px solid var(--spectrum-gray-200)",
                  fontSize: 13,
                }}
              >
                {children}
              </td>
            ),
            ul: ({ children }) => (
              <ul style={{ margin: "4px 0", paddingLeft: 20 }}>{children}</ul>
            ),
            li: ({ children }) => (
              <li style={{ margin: "2px 0" }}>{children}</li>
            ),
            hr: () => (
              <hr
                style={{
                  border: "none",
                  borderTop: "1px solid var(--spectrum-gray-300)",
                  margin: "12px 0",
                }}
              />
            ),
            strong: ({ children }) => <strong>{children}</strong>,
          }}
        >
          {doc}
        </Markdown>
      </div>
    </div>
  );
}
