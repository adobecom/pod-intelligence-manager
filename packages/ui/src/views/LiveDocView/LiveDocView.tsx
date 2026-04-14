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
        className="living-doc"
        style={{
          maxWidth: 720,
          lineHeight: 1.6,
          fontSize: 14,
        }}
      >
        <Markdown>{doc}</Markdown>
      </div>
    </div>
  );
}
