import { Outlet, useNavigate, useParams } from "react-router-dom";
import { Heading, Picker, PickerItem } from "@react-spectrum/s2";
import { style } from "@react-spectrum/s2/style" with { type: "macro" };

const podOptions = [
  { id: "pod-checkout-redesign", name: "Checkout Redesign" },
  { id: "pod-auth-revamp", name: "User Auth Revamp" },
  { id: "pod-search-infra", name: "Search Infra v2" },
];

const topBar = style({
  display: "flex",
  alignItems: "center",
  gap: 16,
  paddingX: 16,
  paddingY: 8,
  borderBottomWidth: 1,
  borderStyle: "solid",
  borderColor: "gray-300",
  backgroundColor: "gray-75",
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
          {podOptions.map((p) => (
            <PickerItem key={p.id} id={p.id}>
              {p.name}
            </PickerItem>
          ))}
        </Picker>

        <div style={{ flex: 1, display: "flex", justifyContent: "flex-end" }}>
          <a
            onClick={() => navigate("/org")}
            style={{
              cursor: "pointer",
              fontSize: 14,
              color: "var(--spectrum-accent-color-900)",
              textDecoration: "none",
            }}
          >
            Org Dashboard
          </a>
        </div>
      </div>

      <div className={contentArea}>
        <Outlet />
      </div>
    </div>
  );
}
