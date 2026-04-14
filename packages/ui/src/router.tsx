import { createBrowserRouter, Navigate } from "react-router-dom";
import { AppLayout } from "./layouts/AppLayout";
import { PodLayout } from "./layouts/PodLayout";
import { OrgDashboard } from "./views/OrgDashboard/OrgDashboard";
import { PodDashboard } from "./views/PodDashboard/PodDashboard";
import { ConflictCenter } from "./views/ConflictCenter/ConflictCenter";
import { ConflictDetail } from "./views/ConflictCenter/ConflictDetail";
import { LiveDocView } from "./views/LiveDocView/LiveDocView";
import { ContextFeed } from "./views/ContextFeed/ContextFeed";
import { TunnelDashboard } from "./views/TunnelDashboard/TunnelDashboard";
import { KnowledgeGraphView } from "./views/KnowledgeGraph/KnowledgeGraph";

export const router = createBrowserRouter([
  {
    element: <AppLayout />,
    children: [
      { path: "/", element: <Navigate to="/org" replace /> },
      { path: "/org", element: <OrgDashboard /> },
      { path: "/knowledge", element: <KnowledgeGraphView /> },
      {
        path: "/pod/:podId",
        element: <PodLayout />,
        children: [
          { index: true, element: <PodDashboard /> },
          { path: "conflicts", element: <ConflictCenter /> },
          { path: "conflict/:conflictId", element: <ConflictDetail /> },
          { path: "doc", element: <LiveDocView /> },
          { path: "feed", element: <ContextFeed /> },
          { path: "tunnels", element: <TunnelDashboard /> },
        ],
      },
    ],
  },
]);
