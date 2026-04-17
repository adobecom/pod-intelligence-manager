import { create } from "zustand";
import type {
  Pod,
  Project,
  OrgPodSummary,
  CrossPodOverlap,
  ArchivedPod,
} from "@council/shared";
import * as api from "../services/api";

interface OrgStore {
  pods: OrgPodSummary[];
  projects: Project[];
  overlaps: CrossPodOverlap[];
  archivedPods: ArchivedPod[];
  loading: boolean;

  loadOrg: () => Promise<void>;
  createPod: (input: {
    name: string;
    sprint_days?: number;
    milestone_name?: string;
    project_id?: string;
  }) => Promise<Pod>;
  createProject: (input: { name: string; description?: string }) => Promise<Project>;
  archivePod: (podId: string) => Promise<void>;
}

async function fetchOrgSnapshot() {
  const [pods, overlaps, archivedPods, projects] = await Promise.all([
    api.getOrgPods(),
    api.getCrossPodOverlaps(),
    api.getArchivedPods(),
    api.getProjects(),
  ]);
  return { pods, overlaps, archivedPods, projects };
}

export const useOrgStore = create<OrgStore>((set) => ({
  pods: [],
  projects: [],
  overlaps: [],
  archivedPods: [],
  loading: false,

  loadOrg: async () => {
    set({ loading: true });
    const snapshot = await fetchOrgSnapshot();
    set({ ...snapshot, loading: false });
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
    await api.archivePod(podId);
    const snapshot = await fetchOrgSnapshot();
    set(snapshot);
  },
}));
