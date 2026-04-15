import { create } from "zustand";
import type { Pod, Conflict, ContextUpdate, Tunnel } from "@council/shared";
import * as api from "../services/api";
import type { ContextUpdateInput, SubmitResult } from "../services/api";

interface PodStore {
  pod: Pod | null;
  conflicts: Conflict[];
  contextUpdates: ContextUpdate[];
  tunnels: Tunnel[];
  loading: boolean;
  error: string | null;

  loadPod: (podId: string) => Promise<void>;
  resolveConflict: (
    conflictId: string,
    resolution: string,
  ) => Promise<void>;
  submitContextUpdate: (
    input: ContextUpdateInput,
  ) => Promise<SubmitResult | null>;
}

export const usePodStore = create<PodStore>((set, get) => ({
  pod: null,
  conflicts: [],
  contextUpdates: [],
  tunnels: [],
  loading: false,
  error: null,

  loadPod: async (podId: string) => {
    set({ loading: true, error: null });
    try {
      const [pod, conflicts, contextUpdates, tunnels] = await Promise.all([
        api.getPod(podId),
        api.getConflicts(podId),
        api.getContextUpdates(podId),
        api.getTunnels(podId),
      ]);
      set({ pod, conflicts, contextUpdates, tunnels, loading: false });
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : "Failed to load pod" });
    }
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

  submitContextUpdate: async (input: ContextUpdateInput) => {
    const { pod, contextUpdates } = get();
    if (!pod) return null;
    const result = await api.submitContextUpdate(pod.pod_id, input);
    set({ contextUpdates: [result.update, ...contextUpdates] });
    return result;
  },
}));
