import { useEffect, useCallback, useRef, useState } from "react";
import { Outlet, useNavigate, useParams, useLocation } from "react-router-dom";
import { Heading, Header, Picker, PickerItem, PickerSection, Button, StatusLight, Text } from "@react-spectrum/s2";
import { style } from "@react-spectrum/s2/style" with { type: "macro" };
import { useOrgStore } from "../stores/orgStore";
import { usePodStore } from "../stores/podStore";
import { useProjectStore } from "../stores/projectStore";
import { useWebSocket } from "../hooks/useWebSocket";
import { useAuth } from "../contexts/AuthContext";
import { useOrg } from "../contexts/OrgContext";
import { OrgSwitcher } from "../components/OrgSwitcher";
import { CreateOrgModal } from "../views/CreateOrg/CreateOrgModal";

const loadOrg = useOrgStore.getState().loadOrg;
const loadPod = usePodStore.getState().loadPod;
const loadProject = useProjectStore.getState().loadProject;

/** Events that change pod data and warrant a re-fetch. */
const POD_DATA_EVENTS = new Set([
  "context_update_added",
  "context_update_quality_revised",
  "conflict_created",
  "conflict_resolved",
  "pressure_changed",
  "tunnel_status_changed",
]);

const THROTTLE_MS = 5_000;

/** Adobe brand red (primary) */
const ADOBE_RED = "#e1251b";

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
  const { podId, projectId } = useParams();
  const location = useLocation();
  const pods = useOrgStore((s) => s.pods);
  const projects = useOrgStore((s) => s.projects);
  const lastPodReload = useRef(0);
  const lastProjectReload = useRef(0);
  const { signOut } = useAuth();
  const { currentOrg } = useOrg();
  const [createOrgOpen, setCreateOrgOpen] = useState(false);

  const isOrgPage = location.pathname === "/org";

  /** Pod room for sprint events; `global` receives broadcastToAll (including project updates). */
  const wsRoomId = podId ?? (projectId ? "global" : undefined);

  const scopeKey = podId ?? projectId ?? null;
  const hasScopeOptions = pods.length > 0 || projects.length > 0;

  // Re-fetch org data whenever the selected org changes (e.g. via OrgSwitcher).
  useEffect(() => {
    if (currentOrg) loadOrg();
  }, [currentOrg?.slug]);

  const handleWSEvent = useCallback(
    (event: { type: string; payload?: unknown }) => {
      if (event.type === "project_context_update_added") {
        const payload = event.payload as { projectId?: string } | undefined;
        if (projectId && payload?.projectId === projectId) {
          const now = Date.now();
          if (now - lastProjectReload.current < THROTTLE_MS) return;
          lastProjectReload.current = now;
          loadProject(projectId);
        }
        return;
      }

      if (!podId || !POD_DATA_EVENTS.has(event.type)) return;
      const now = Date.now();
      if (now - lastPodReload.current < THROTTLE_MS) return;
      lastPodReload.current = now;
      loadPod(podId);
    },
    [podId, projectId],
  );

  const wsStatus = useWebSocket(wsRoomId, handleWSEvent);
  const wsVariant = wsStatus === "connected" ? "positive" : wsStatus === "connecting" ? "notice" : "negative";
  const wsLabel = wsStatus === "connected" ? "Live" : wsStatus === "connecting" ? "Connecting" : "Disconnected";

  return (
    <div className={appContainer}>
      <div className={topBar}>
        <Heading level={3} styles={style({ marginY: 0, whiteSpace: "nowrap", flexShrink: 0 })}>
          <span style={{ color: ADOBE_RED }}>PIM</span>
        </Heading>

        <div className={style({ display: "flex", flexDirection: "column", gap: 4, alignItems: "start" })}>
          <Picker
            label="Scope"
            labelPosition="side"
            selectedKey={scopeKey}
            onSelectionChange={(key) => {
              if (!key) return;
              const k = String(key);
              if (pods.some((p) => p.pod_id === k)) {
                navigate(`/pod/${k}`);
              } else if (projects.some((p) => p.project_id === k)) {
                navigate(`/project/${k}`);
              }
            }}
            isDisabled={!hasScopeOptions}
          >
            {pods.length > 0 && (
              <PickerSection>
                <Header>Pods</Header>
                {pods.map((p) => (
                  <PickerItem key={p.pod_id} id={p.pod_id} textValue={p.name}>
                    {p.name}
                  </PickerItem>
                ))}
              </PickerSection>
            )}
            {projects.length > 0 && (
              <PickerSection>
                <Header>Projects</Header>
                {projects.map((p) => (
                  <PickerItem key={p.project_id} id={p.project_id} textValue={p.name}>
                    {p.name}
                  </PickerItem>
                ))}
              </PickerSection>
            )}
          </Picker>
          {!hasScopeOptions && (
            <Text styles={style({ font: "body-2xs", color: "neutral-subdued" })}>
              No pods or projects yet — create them from the org dashboard.
            </Text>
          )}
        </div>

        {podId && <StatusLight variant={wsVariant}>{wsLabel}</StatusLight>}

        <div className={style({ flexGrow: 1, display: "flex", justifyContent: "end", gap: 8, alignItems: "center" })}>
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
          <Button
            variant={location.pathname === "/org/members" ? "accent" : "secondary"}
            onPress={() => navigate("/org/members")}
          >
            Members
          </Button>
          <OrgSwitcher onCreateOrg={() => setCreateOrgOpen(true)} onSignOut={signOut} />
        </div>
      </div>

      <div className={contentArea}>
        <Outlet />
      </div>

      <CreateOrgModal isOpen={createOrgOpen} onOpenChange={setCreateOrgOpen} />
    </div>
  );
}
