import { create } from "zustand";
import type {
  Pod,
  Project,
  OrgPodSummary,
  OrgConfig,
  CrossPodOverlap,
  ArchivedPod,
  ArchivedProject,
} from "@council/shared";
import * as api from "../services/api";

interface OrgStore {
  pods: OrgPodSummary[];
  projects: Project[];
  overlaps: CrossPodOverlap[];
  archivedPods: ArchivedPod[];
  archivedProjects: ArchivedProject[];
  orgConfig: OrgConfig | null;
  loading: boolean;

  loadOrg: () => Promise<void>;
  loadOrgConfig: () => Promise<void>;
  saveOrgConfig: (config: OrgConfig) => Promise<OrgConfig>;
  createPod: (input: {
    name: string;
    sprint_days?: number;
    milestone_name?: string;
    project_id?: string;
  }) => Promise<Pod>;
  createProject: (input: { name: string; description?: string }) => Promise<Project>;
  archivePod: (podId: string) => Promise<ArchivedPod>;
  archiveProject: (projectId: string) => Promise<ArchivedProject>;
}

async function fetchOrgSnapshot() {
  const [pods, overlaps, archivedPods, archivedProjects, projects, orgConfig] = await Promise.all([
    api.getOrgPods(),
    api.getCrossPodOverlaps(),
    api.getArchivedPods(),
    api.getArchivedProjects(),
    api.getProjects(),
    api.getOrgConfig(),
  ]);
  return { pods, overlaps, archivedPods, archivedProjects, projects, orgConfig };
}

export const useOrgStore = create<OrgStore>((set) => ({
  pods: [],
  projects: [],
  overlaps: [],
  archivedPods: [],
  archivedProjects: [],
  orgConfig: null,
  loading: false,

  loadOrg: async () => {
    set({ loading: true });
    const snapshot = await fetchOrgSnapshot();
    set({ ...snapshot, loading: false });
  },

  loadOrgConfig: async () => {
    const orgConfig = await api.getOrgConfig();
    set({ orgConfig });
  },

  saveOrgConfig: async (config) => {
    const orgConfig = await api.patchOrgConfig(config);
    set({ orgConfig });
    return orgConfig;
  },

  createPod: async (input) => {
    const pod = await api.createPod(input);
    const snapshot = await fetchOrgSnapshot();
    set(snapshot);
    return pod;
  },

  createProject: async (input) => {
    const project = await api.createProject(input);
    const snapshot = await fetchOrgSnapshot();
    set(snapshot);
    return project;
  },

  archivePod: async (podId) => {
    const archived = await api.archivePod(podId);
    const snapshot = await fetchOrgSnapshot();
    set(snapshot);
    return archived;
  },

  archiveProject: async (projectId) => {
    const archived = await api.archiveProject(projectId);
    const snapshot = await fetchOrgSnapshot();
    set(snapshot);
    return archived;
  },
}));
