import { create } from "zustand";
import type {
  Pod,
  OrgPodSummary,
  CrossPodOverlap,
  ArchivedPod,
} from "@council/shared";
import * as api from "../services/api";

interface OrgStore {
  pods: OrgPodSummary[];
  overlaps: CrossPodOverlap[];
  archivedPods: ArchivedPod[];
  loading: boolean;

  loadOrg: () => Promise<void>;
  createPod: (input: {
    name: string;
    sprint_days?: number;
    milestone_name?: string;
  }) => Promise<Pod>;
  archivePod: (podId: string) => Promise<void>;
}

export const useOrgStore = create<OrgStore>((set) => ({
  pods: [],
  overlaps: [],
  archivedPods: [],
  loading: false,

  loadOrg: async () => {
    set({ loading: true });
    const [pods, overlaps, archivedPods] = await Promise.all([
      api.getOrgPods(),
      api.getCrossPodOverlaps(),
      api.getArchivedPods(),
    ]);
    set({ pods, overlaps, archivedPods, loading: false });
  },

  createPod: async (input) => {
    const pod = await api.createPod(input);
    // Reload org data to pick up the new pod
    const [pods, overlaps, archivedPods] = await Promise.all([
      api.getOrgPods(),
      api.getCrossPodOverlaps(),
      api.getArchivedPods(),
    ]);
    set({ pods, overlaps, archivedPods });
    return pod;
  },

  archivePod: async (podId) => {
    await api.archivePod(podId);
    // Reload org data
    const [pods, overlaps, archivedPods] = await Promise.all([
      api.getOrgPods(),
      api.getCrossPodOverlaps(),
      api.getArchivedPods(),
    ]);
    set({ pods, overlaps, archivedPods });
  },
}));
