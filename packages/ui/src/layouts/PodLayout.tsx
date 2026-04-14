import { useCallback, useEffect } from "react";
import { Outlet, useParams, NavLink, useLocation } from "react-router-dom";
import { ProgressCircle } from "@react-spectrum/s2";
import { style } from "@react-spectrum/s2/style" with { type: "macro" };
import { usePodStore } from "../stores/podStore";
import { useWebSocket } from "../hooks/useWebSocket";

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
  backgroundColor: "gray-50",
  borderEndWidth: 1,
  borderStyle: "solid",
  borderColor: "gray-300",
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
  const { loadPod, loading, pod } = usePodStore();
  const location = useLocation();

  useEffect(() => {
    if (podId) loadPod(podId);
  }, [podId, loadPod]);

  const handleWSEvent = useCallback(() => {
    // On any WebSocket event, reload the pod data
    if (podId) loadPod(podId);
  }, [podId, loadPod]);

  useWebSocket(podId, handleWSEvent);

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
                style={{
                  display: "block",
                  padding: "8px 16px",
                  textDecoration: "none",
                  fontSize: 14,
                  color: isActive
                    ? "var(--spectrum-accent-color-900)"
                    : "var(--spectrum-gray-800)",
                  backgroundColor: isActive
                    ? "var(--spectrum-accent-color-100)"
                    : "transparent",
                  borderLeft: isActive
                    ? "3px solid var(--spectrum-accent-color-900)"
                    : "3px solid transparent",
                }}
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
