import { create } from "zustand";
import type { Pod, Conflict, ContextUpdate, Tunnel } from "@council/shared";
import * as api from "../services/api";

interface PodStore {
  pod: Pod | null;
  conflicts: Conflict[];
  contextUpdates: ContextUpdate[];
  tunnels: Tunnel[];
  loading: boolean;

  loadPod: (podId: string) => Promise<void>;
  resolveConflict: (
    conflictId: string,
    resolution: string,
  ) => Promise<void>;
}

export const usePodStore = create<PodStore>((set, get) => ({
  pod: null,
  conflicts: [],
  contextUpdates: [],
  tunnels: [],
  loading: false,

  loadPod: async (podId: string) => {
    set({ loading: true });
    const [pod, conflicts, contextUpdates, tunnels] = await Promise.all([
      api.getPod(podId),
      api.getConflicts(podId),
      api.getContextUpdates(podId),
      api.getTunnels(podId),
    ]);
    set({ pod, conflicts, contextUpdates, tunnels, loading: false });
  },

  resolveConflict: async (conflictId: string, resolution: string) => {
    const { pod, conflicts } = get();
    if (!pod) return;
    const resolved = await api.resolveConflict(
      pod.pod_id,
      conflictId,
      resolution,
      "current-user",
    );
    if (resolved) {
      set({
        conflicts: conflicts.map((c) =>
          c.id === conflictId ? resolved : c,
        ),
      });
    }
  },
}));
