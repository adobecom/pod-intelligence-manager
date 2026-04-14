import {
  Heading,
  Cell,
  Column,
  Row,
  TableView,
  TableBody,
  TableHeader,
  Text,
  Link,
} from "@react-spectrum/s2";
import { style } from "@react-spectrum/s2/style" with { type: "macro" };
import { usePodStore } from "../../stores/podStore";
import { TunnelStatusLight } from "../../components/TunnelStatusLight";
import { RelativeTime } from "../../components/RelativeTime";

const column = style({ display: "flex", flexDirection: "column", gap: 20 });

export function TunnelDashboard() {
  const tunnels = usePodStore((s) => s.tunnels);

  return (
    <div className={column}>
      <Heading level={2} styles={style({ marginY: 0 })}>
        Tunnels ({tunnels.length})
      </Heading>

      <TableView aria-label="Active tunnels" selectionMode="none">
        <TableHeader>
          <Column id="dev" isRowHeader>Dev</Column>
          <Column id="branch">Branch</Column>
          <Column id="url">URL</Column>
          <Column id="status">Status</Column>
          <Column id="lastActivity">Last Activity</Column>
        </TableHeader>
        <TableBody>
          {tunnels.map((tunnel) => (
            <Row key={tunnel.tunnel_id} id={tunnel.tunnel_id}>
              <Cell>
                <Text styles={style({ fontWeight: "bold" })}>
                  {tunnel.dev_name}
                </Text>
              </Cell>
              <Cell><Text>{tunnel.branch}</Text></Cell>
              <Cell>
                <Link
                  href={`https://${tunnel.url}`}
                  target="_blank"
                >
                  {tunnel.url}
                </Link>
              </Cell>
              <Cell>
                <TunnelStatusLight status={tunnel.status} />
              </Cell>
              <Cell>
                <RelativeTime timestamp={tunnel.last_activity} />
              </Cell>
            </Row>
          ))}
        </TableBody>
      </TableView>
    </div>
  );
}
