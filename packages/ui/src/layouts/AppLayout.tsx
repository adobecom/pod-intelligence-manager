import { useEffect } from "react";
import { Outlet, useNavigate, useParams } from "react-router-dom";
import { Heading, Picker, PickerItem, Button } from "@react-spectrum/s2";
import { style } from "@react-spectrum/s2/style" with { type: "macro" };
import { useOrgStore } from "../stores/orgStore";

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
  const pods = useOrgStore((s) => s.pods);
  const loadOrg = useOrgStore((s) => s.loadOrg);

  useEffect(() => {
    loadOrg();
  }, [loadOrg]);

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

        <div className={style({ flexGrow: 1, display: "flex", justifyContent: "end" })}>
          <Button onPress={() => navigate("/org")}>
            Org Dashboard
          </Button>
        </div>
      </div>

      <div className={contentArea}>
        <Outlet />
      </div>
    </div>
  );
}
