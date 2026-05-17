import { create } from "zustand";
import type {
  Pod,
  Project,
  OrgPodSummary,
  OrgConfig,
  OrgTuning,
  CrossPodOverlap,
  ArchivedPod,
  ArchivedProject,
} from "@pim/shared";
import * as api from "../services/api";
import type { TuningHistoryEntry } from "../services/api";

interface OrgStore {
  pods: OrgPodSummary[];
  projects: Project[];
  overlaps: CrossPodOverlap[];
  archivedPods: ArchivedPod[];
  archivedProjects: ArchivedProject[];
  orgConfig: OrgConfig | null;
  orgTuning: OrgTuning | null;
  tuningHistory: TuningHistoryEntry[];
  loading: boolean;

  loadOrg: () => Promise<void>;
  loadOrgConfig: () => Promise<void>;
  saveOrgConfig: (config: OrgConfig) => Promise<OrgConfig>;
  loadOrgTuning: () => Promise<void>;
  resetOrgTuning: () => Promise<OrgTuning>;
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
  orgTuning: null,
  tuningHistory: [],
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

  loadOrgTuning: async () => {
    const [orgTuning, tuningHistory] = await Promise.all([
      api.getOrgTuning(),
      api.getOrgTuningHistory(),
    ]);
    set({ orgTuning, tuningHistory: tuningHistory ?? [] });
  },

  resetOrgTuning: async () => {
    const orgTuning = await api.deleteOrgTuning();
    const tuningHistory = await api.getOrgTuningHistory();
    set({ orgTuning, tuningHistory: tuningHistory ?? [] });
    return orgTuning;
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
