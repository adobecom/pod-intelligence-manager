import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  Heading,
  Picker,
  PickerItem,
  Cell,
  Column,
  Row,
  TableView,
  TableBody,
  TableHeader,
  Text,
  ActionButton,
} from "@react-spectrum/s2";
import { style } from "@react-spectrum/s2/style" with { type: "macro" };
import { usePodStore } from "../../stores/podStore";
import { SeverityBadge } from "../../components/SeverityBadge";
import { EscalationBadge } from "../../components/EscalationBadge";
import { RelativeTime } from "../../components/RelativeTime";

const column = style({
  display: "flex",
  flexDirection: "column",
  gap: 20,
});

const filterRow = style({
  display: "flex",
  gap: 12,
  alignItems: "end",
});

const statusCell = style({
  display: "flex",
  gap: 8,
  alignItems: "center",
});

export function ConflictCenter() {
  const conflicts = usePodStore((s) => s.conflicts);
  const navigate = useNavigate();
  const { podId } = useParams();
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [severityFilter, setSeverityFilter] = useState<string>("all");

  const filtered = conflicts.filter((c) => {
    if (statusFilter !== "all" && c.status !== statusFilter) return false;
    if (severityFilter !== "all" && c.severity !== severityFilter) return false;
    return true;
  });

  return (
    <div className={column}>
      <Heading level={2} styles={style({ marginY: 0 })}>
        Conflict Center
      </Heading>

      <div className={filterRow}>
        <Picker
          label="Status"
          selectedKey={statusFilter}
          onSelectionChange={(key) => setStatusFilter(key as string)}
        >
          <PickerItem id="all">All</PickerItem>
          <PickerItem id="open">Open</PickerItem>
          <PickerItem id="in_discussion">In Discussion</PickerItem>
          <PickerItem id="resolved">Resolved</PickerItem>
        </Picker>

        <Picker
          label="Severity"
          selectedKey={severityFilter}
          onSelectionChange={(key) => setSeverityFilter(key as string)}
        >
          <PickerItem id="all">All</PickerItem>
          <PickerItem id="blocking">Blocking</PickerItem>
          <PickerItem id="non_blocking">Non-blocking</PickerItem>
        </Picker>
      </div>

      <TableView
        aria-label="Conflicts"
        selectionMode="none"
        onAction={(key) => navigate(`/pod/${podId}/conflict/${key}`)}
      >
        <TableHeader>
          <Column id="id" isRowHeader>ID</Column>
          <Column id="summary">Summary</Column>
          <Column id="severity">Severity</Column>
          <Column id="status">Status</Column>
          <Column id="created">Opened</Column>
          <Column id="actions">Actions</Column>
        </TableHeader>
        <TableBody>
          {filtered.map((conflict) => (
            <Row key={conflict.id} id={conflict.id}>
              <Cell>
                <Text styles={style({ fontWeight: "bold" })}>{conflict.id}</Text>
              </Cell>
              <Cell><Text>{conflict.summary}</Text></Cell>
              <Cell><SeverityBadge severity={conflict.severity} /></Cell>
              <Cell>
                <div className={statusCell}>
                  <Text styles={style({ textTransform: "capitalize" })}>
                    {conflict.status.replace("_", " ")}
                  </Text>
                  {conflict.status !== "resolved" ? (
                    <EscalationBadge level={conflict.escalation_level ?? 0} compact />
                  ) : null}
                </div>
              </Cell>
              <Cell><RelativeTime timestamp={conflict.created_at} /></Cell>
              <Cell>
                <ActionButton
                  onPress={() =>
                    navigate(`/pod/${podId}/conflict/${conflict.id}`)
                  }
                >
                  View
                </ActionButton>
              </Cell>
            </Row>
          ))}
        </TableBody>
      </TableView>
    </div>
  );
}
