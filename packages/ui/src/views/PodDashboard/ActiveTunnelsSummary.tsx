import { Heading, Text, Link } from "@react-spectrum/s2";
import { style } from "@react-spectrum/s2/style" with { type: "macro" };
import { usePodStore } from "../../stores/podStore";
import { TunnelStatusLight } from "../../components/TunnelStatusLight";

const column = style({
  display: "flex",
  flexDirection: "column",
  gap: 8,
});

const card = style({
  backgroundColor: "gray-75",
  padding: 12,
  borderRadius: "default",
  borderWidth: 1,
  borderStyle: "solid",
  borderColor: "gray-300",
});

const row = style({
  display: "flex",
  alignItems: "center",
  gap: 12,
});

const devInfo = style({
  display: "flex",
  flexDirection: "column",
  flexGrow: 1,
  minWidth: 0,
});

export function ActiveTunnelsSummary() {
  const tunnels = usePodStore((s) => s.tunnels);

  return (
    <div>
      <Heading level={4}>
        Active Tunnels ({tunnels.length})
      </Heading>
      {tunnels.length === 0 ? (
        <Text styles={style({ color: "gray-600" })}>
          No active tunnels
        </Text>
      ) : (
        <div className={column}>
          {tunnels.map((tunnel) => (
            <div key={tunnel.tunnel_id} className={card}>
              <div className={row}>
                <TunnelStatusLight status={tunnel.status} />
                <div className={devInfo}>
                  <Text styles={style({ font: "body-sm", fontWeight: "bold" })}>
                    {tunnel.dev_name}
                  </Text>
                  <Text styles={style({ font: "body-2xs", color: "gray-600" })}>
                    {tunnel.branch}
                  </Text>
                </div>
                <Link
                  href={`https://${tunnel.url}`}
                  target="_blank"
                >
                  {tunnel.url}
                </Link>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
