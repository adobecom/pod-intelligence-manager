import {
  Heading,
  Cell,
  Column,
  Row,
  TableView,
  TableBody,
  TableHeader,
  Text,
} from "@react-spectrum/s2";
import { style } from "@react-spectrum/s2/style" with { type: "macro" };
import type { PodArea } from "@pim/shared";
import { StatusIndicator } from "../../components/StatusIndicator";
import { RelativeTime } from "../../components/RelativeTime";

interface StatusByAreaProps {
  areas: PodArea[];
}

export function StatusByArea({ areas }: StatusByAreaProps) {
  return (
    <div>
      <Heading level={4}>Status by Area</Heading>
      <TableView aria-label="Status by area" selectionMode="none">
        <TableHeader>
          <Column id="scope" isRowHeader>Area</Column>
          <Column id="owner">Owner</Column>
          <Column id="status">Status</Column>
          <Column id="lastActivity">Last Activity</Column>
        </TableHeader>
        <TableBody>
          {areas.map((area) => (
            <Row key={area.scope} id={area.scope}>
              <Cell>
                <Text styles={style({ textTransform: "capitalize" })}>
                  {area.scope}
                </Text>
              </Cell>
              <Cell><Text>{area.owner}</Text></Cell>
              <Cell>
                <StatusIndicator status={area.status} />
              </Cell>
              <Cell>
                <RelativeTime timestamp={area.last_activity} />
              </Cell>
            </Row>
          ))}
        </TableBody>
      </TableView>
    </div>
  );
}
