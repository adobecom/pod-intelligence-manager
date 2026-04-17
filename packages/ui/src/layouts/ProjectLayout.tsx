import { useEffect } from "react";
import { Outlet, useParams, NavLink, useLocation } from "react-router-dom";
import { Button, Content, Heading, IllustratedMessage, ProgressCircle } from "@react-spectrum/s2";
import { style } from "@react-spectrum/s2/style" with { type: "macro" };
import { useProjectStore } from "../stores/projectStore";
import { useOrgStore } from "../stores/orgStore";

const loadProject = useProjectStore.getState().loadProject;
const loadOrgConfig = useOrgStore.getState().loadOrgConfig;

const navItems = [
  { path: "", label: "Overview", end: true },
  { path: "feed", label: "Context Feed" },
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

const errorColumn = style({
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: 16,
});

export function ProjectLayout() {
  const { projectId } = useParams<{ projectId: string }>();
  const loading = useProjectStore((s) => s.loading);
  const project = useProjectStore((s) => s.project);
  const error = useProjectStore((s) => s.error);
  const location = useLocation();

  useEffect(() => {
    void loadOrgConfig();
  }, []);

  useEffect(() => {
    if (projectId) loadProject(projectId);
  }, [projectId]);

  if (error && !loading) {
    return (
      <div className={loadingContainer}>
        <div className={errorColumn}>
          <IllustratedMessage>
            <Heading>Failed to load project</Heading>
            <Content>{error}</Content>
          </IllustratedMessage>
          <Button variant="primary" onPress={() => projectId && loadProject(projectId)}>
            Retry
          </Button>
        </div>
      </div>
    );
  }

  if (loading || !project) {
    return (
      <div className={loadingContainer}>
        <ProgressCircle aria-label="Loading project..." isIndeterminate />
      </div>
    );
  }

  return (
    <div className={layoutContainer}>
      <div className={sidebar}>
        <nav>
          {navItems.map(({ path, label, end }) => {
            const to = `/project/${projectId}${path ? `/${path}` : ""}`;
            const isActive = end
              ? location.pathname === `/project/${projectId}`
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
