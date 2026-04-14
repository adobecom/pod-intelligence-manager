import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import {
  Heading,
  Text,
  Button,
  InlineAlert,
  Content,
  TextArea,
  Divider,
  ActionButton,
  Badge,
  Cell,
  Column,
  Row,
  TableView,
  TableBody,
  TableHeader,
} from "@react-spectrum/s2";
import { style } from "@react-spectrum/s2/style" with { type: "macro" };
import type { PendingWork } from "@council/shared";
import { SeverityBadge } from "../../components/SeverityBadge";
import { RelativeTime } from "../../components/RelativeTime";
import { usePodStore } from "../../stores/podStore";
import * as api from "../../services/api";

const column = style({ display: "flex", flexDirection: "column", gap: 20 });
const row = style({ display: "flex", gap: 12, flexWrap: "wrap" });
const headerRow = style({ display: "flex", alignItems: "center", gap: 12 });
const positionCard = style({
  backgroundColor: "layer-1",
  borderRadius: "default",
  padding: 16,
  borderWidth: 1,
  borderStyle: "solid",
  borderColor: "gray-200",
  flexGrow: 1,
  flexBasis: "[300px]",
  minWidth: 0,
});
const positionContent = style({ display: "flex", flexDirection: "column", gap: 8 });
const positionMeta = style({ display: "flex", alignItems: "center", gap: 8 });
const well = style({
  backgroundColor: "layer-1",
  borderRadius: "default",
  padding: 16,
  borderWidth: 1,
  borderStyle: "solid",
  borderColor: "gray-200",
});
const buttonRow = style({ display: "flex", gap: 12, flexWrap: "wrap" });
const customForm = style({ display: "flex", flexDirection: "column", gap: 12 });

export function ConflictDetail() {
  const { podId, conflictId } = useParams<{
    podId: string;
    conflictId: string;
  }>();
  const navigate = useNavigate();
  const conflicts = usePodStore((s) => s.conflicts);
  const resolveConflict = usePodStore((s) => s.resolveConflict);
  const [pending, setPending] = useState<PendingWork[]>([]);
  const [showCustom, setShowCustom] = useState(false);
  const [customResolution, setCustomResolution] = useState("");

  const conflict = conflicts.find((c) => c.id === conflictId) ?? null;

  useEffect(() => {
    if (conflictId) {
      api.getPendingWork(conflictId).then(setPending);
    }
  }, [conflictId]);

  if (!conflict) {
    return <Text>Conflict not found.</Text>;
  }

  const isResolved = conflict.status === "resolved";

  async function handleResolve(resolution: string) {
    if (!conflictId) return;
    await resolveConflict(conflictId, resolution);
    navigate(`/pod/${podId}/conflicts`);
  }

  return (
    <div className={column}>
      <ActionButton
        onPress={() => navigate(`/pod/${podId}/conflicts`)}
      >
        Back to Conflicts
      </ActionButton>

      {/* Header */}
      <div className={headerRow}>
        <Heading level={2} styles={style({ marginY: 0 })}>
          {conflict.id}: {conflict.summary}
        </Heading>
        <SeverityBadge severity={conflict.severity} />
        {isResolved && <Badge variant="positive">Resolved</Badge>}
      </div>

      <Text styles={style({ color: "neutral-subdued" })}>
        Opened <RelativeTime timestamp={conflict.created_at} />
      </Text>

      {/* Position Comparison */}
      <Heading level={3}>Positions</Heading>
      <div className={row}>
        {conflict.sides.map((side, i) => (
          <div key={side.contributor} className={positionCard}>
            <div className={positionContent}>
              <div className={positionMeta}>
                <Badge variant={i === 0 ? "seafoam" : "purple"}>
                  Position {String.fromCharCode(65 + i)}
                </Badge>
                <Text styles={style({ fontWeight: "bold" })}>
                  {side.contributor}
                </Text>
              </div>
              <Text>{side.position}</Text>
              <Text styles={style({ font: "body-2xs", color: "neutral-subdued" })}>
                Submitted <RelativeTime timestamp={side.timestamp} />
                {" · "}Ref: {side.context_update_id}
              </Text>
            </div>
          </div>
        ))}
      </div>

      {/* Master Analysis */}
      <Heading level={3}>Council Master Analysis</Heading>
      <InlineAlert variant="informative">
        <Heading>Analysis</Heading>
        <Content>
          <Text>{conflict.master_analysis}</Text>
        </Content>
      </InlineAlert>

      {conflict.impact.length > 0 && (
        <>
          <Heading level={4}>Impact</Heading>
          <ul style={{ margin: 0, paddingLeft: 20 }}>
            {conflict.impact.map((item, i) => (
              <li key={i}><Text>{item}</Text></li>
            ))}
          </ul>
        </>
      )}

      {/* Pending Work */}
      {pending.length > 0 && (
        <>
          <Heading level={3}>Pending Work (Presumption-Tagged)</Heading>
          <TableView aria-label="Pending work" selectionMode="none">
            <TableHeader>
              <Column id="agent" isRowHeader>Agent</Column>
              <Column id="summary">Summary</Column>
              <Column id="presumes">Presumes</Column>
              <Column id="cost">Rework Cost</Column>
            </TableHeader>
            <TableBody>
              {pending.map((pw) => (
                <Row key={pw.context_update_id} id={pw.context_update_id}>
                  <Cell><Text>{pw.agent_id}</Text></Cell>
                  <Cell><Text>{pw.summary}</Text></Cell>
                  <Cell><Badge variant="neutral">{pw.presumes}</Badge></Cell>
                  <Cell><Text>{pw.rework_cost}</Text></Cell>
                </Row>
              ))}
            </TableBody>
          </TableView>
        </>
      )}

      {/* Resolution Panel */}
      {!isResolved && (
        <>
          <Divider />
          <Heading level={3}>Resolve</Heading>
          <div className={buttonRow}>
            {conflict.sides.map((side, i) => (
              <Button
                key={side.contributor}
                variant={i === 0 ? "accent" : "secondary"}
                onPress={() =>
                  handleResolve(
                    `Accepted Position ${String.fromCharCode(65 + i)}: ${side.contributor}'s approach`,
                  )
                }
              >
                Accept {String.fromCharCode(65 + i)}: {side.contributor}
              </Button>
            ))}
            <Button
              variant="secondary"
              onPress={() => setShowCustom(!showCustom)}
            >
              Custom Resolution
            </Button>
          </div>

          {showCustom && (
            <div className={customForm}>
              <TextArea
                label="Custom resolution"
                value={customResolution}
                onChange={setCustomResolution}
              />
              <Button
                variant="accent"
                isDisabled={!customResolution.trim()}
                onPress={() => handleResolve(customResolution)}
              >
                Submit Resolution
              </Button>
            </div>
          )}
        </>
      )}

      {/* Show resolution if resolved */}
      {isResolved && conflict.resolution && (
        <>
          <Divider />
          <Heading level={3}>Resolution</Heading>
          <div className={well}>
            <Text>{conflict.resolution}</Text>
            <br />
            <Text styles={style({ font: "body-2xs", color: "neutral-subdued" })}>
              Resolved by {conflict.resolved_by}{" "}
              <RelativeTime timestamp={conflict.resolution_date} />
            </Text>
          </div>
        </>
      )}
    </div>
  );
}
