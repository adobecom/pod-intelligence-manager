import { create } from "zustand";
import type {
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
}));
