import { useEffect, useCallback } from "react";
import { Outlet, useNavigate, useParams, useLocation } from "react-router-dom";
import { Heading, Picker, PickerItem, Button, StatusLight } from "@react-spectrum/s2";
import { style } from "@react-spectrum/s2/style" with { type: "macro" };
import { useOrgStore } from "../stores/orgStore";
import { usePodStore } from "../stores/podStore";
import { useWebSocket } from "../hooks/useWebSocket";

const topBar = style({
  display: "flex",
  alignItems: "center",
  gap: 16,
  padding: 24,
});

const appContainer = style({
  height: "[100vh]",
  display: "flex",
  flexDirection: "column",
});

const contentArea = style({
  flexGrow: 1,
  overflow: "auto",
});

export function AppLayout() {
  const navigate = useNavigate();
  const { podId } = useParams();
  const location = useLocation();
  const pods = useOrgStore((s) => s.pods);
  const loadOrg = useOrgStore((s) => s.loadOrg);
  const loadPod = usePodStore((s) => s.loadPod);

  const isOrgPage = location.pathname === "/org";

  useEffect(() => {
    loadOrg();
  }, [loadOrg]);

  const handleWSEvent = useCallback(() => {
    if (podId) loadPod(podId);
  }, [podId, loadPod]);

  const wsStatus = useWebSocket(podId, handleWSEvent);
  const wsVariant = wsStatus === "connected" ? "positive" : wsStatus === "connecting" ? "notice" : "negative";
  const wsLabel = wsStatus === "connected" ? "Live" : wsStatus === "connecting" ? "Connecting" : "Disconnected";

  return (
    <div className={appContainer}>
      <div className={topBar}>
        <Heading level={3} styles={style({ marginY: 0, whiteSpace: "nowrap", flexShrink: 0 })}>
          AI Council
        </Heading>

        <Picker
          label="Pod"
          labelPosition="side"
          selectedKey={podId ?? null}
          onSelectionChange={(key) => {
            if (key) navigate(`/pod/${key}`);
          }}
        >
          {pods.map((p) => (
            <PickerItem key={p.pod_id} id={p.pod_id}>
              {p.name}
            </PickerItem>
          ))}
        </Picker>

        {podId && <StatusLight variant={wsVariant}>{wsLabel}</StatusLight>}

        <div className={style({ flexGrow: 1, display: "flex", justifyContent: "end", gap: 8 })}>
          {!isOrgPage && (
            <Button onPress={() => navigate("/org")}>
              Org Dashboard
            </Button>
          )}
          <Button
            variant={location.pathname === "/knowledge" ? "accent" : "secondary"}
            onPress={() => navigate("/knowledge")}
          >
            Knowledge
          </Button>
        </div>
      </div>

      <div className={contentArea}>
        <Outlet />
      </div>
    </div>
  );
}
