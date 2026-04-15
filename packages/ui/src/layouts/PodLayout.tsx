import { useEffect } from "react";
import { Outlet, useParams, NavLink, useLocation } from "react-router-dom";
import { Button, Content, Heading, IllustratedMessage, ProgressCircle } from "@react-spectrum/s2";
import { style } from "@react-spectrum/s2/style" with { type: "macro" };
import { usePodStore } from "../stores/podStore";

const loadPod = usePodStore.getState().loadPod;

const navItems = [
  { path: "", label: "Dashboard", end: true },
  { path: "conflicts", label: "Conflicts" },
  { path: "doc", label: "Live Doc" },
  { path: "feed", label: "Context Feed" },
  { path: "tunnels", label: "Tunnels" },
];

const layoutContainer = style({
  display: "flex",
  height: "full",
});

const sidebar = style({
  width: 192,
  paddingY: 12,
  flexShrink: 0,
});

const mainContent = style({
  flexGrow: 1,
  padding: 24,
  overflow: "auto",
});

const loadingContainer = style({
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  height: "full",
});

export function PodLayout() {
  const { podId } = useParams<{ podId: string }>();
  const loading = usePodStore((s) => s.loading);
  const pod = usePodStore((s) => s.pod);
  const error = usePodStore((s) => s.error);
  const location = useLocation();

  useEffect(() => {
    if (podId) loadPod(podId);
  }, [podId]);

  if (error && !loading) {
    return (
      <div className={loadingContainer}>
        <IllustratedMessage>
          <Heading>Failed to load pod</Heading>
          <Content>{error}</Content>
          <Button variant="primary" onPress={() => podId && loadPod(podId)}>
            Retry
          </Button>
        </IllustratedMessage>
      </div>
    );
  }

  if (loading || !pod) {
    return (
      <div className={loadingContainer}>
        <ProgressCircle aria-label="Loading pod..." isIndeterminate />
      </div>
    );
  }

  return (
    <div className={layoutContainer}>
      <div className={sidebar}>
        <nav>
          {navItems.map(({ path, label, end }) => {
            const to = `/pod/${podId}${path ? `/${path}` : ""}`;
            const isActive = end
              ? location.pathname === `/pod/${podId}`
              : location.pathname.startsWith(to);
            return (
              <NavLink
                key={path}
                to={to}
                end={end}
                className="nav-link"
                data-active={isActive || undefined}
              >
                {label}
              </NavLink>
            );
          })}
        </nav>
      </div>

      <div className={mainContent}>
        <Outlet />
      </div>
    </div>
  );
}
