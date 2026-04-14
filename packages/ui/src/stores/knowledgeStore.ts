import { create } from "zustand";
import type {
  KnowledgeGraph,
  KnowledgeStats,
  KnowledgeNode,
  KnowledgeQueryFilters,
  CurationAction,
} from "@council/shared";
import * as api from "../services/api";

interface KnowledgeStore {
  graph: KnowledgeGraph | null;
  stats: KnowledgeStats | null;
  selectedNodeId: string | null;
  filters: KnowledgeQueryFilters;
  loading: boolean;

  loadGraph: () => Promise<void>;
  loadStats: () => Promise<void>;
  selectNode: (nodeId: string | null) => void;
  setFilters: (filters: KnowledgeQueryFilters) => void;
  curateNode: (
    nodeId: string,
    action: CurationAction,
    edits?: Partial<Pick<KnowledgeNode, "summary" | "details" | "domains">>,
  ) => Promise<void>;
}

export const useKnowledgeStore = create<KnowledgeStore>((set) => ({
  graph: null,
  stats: null,
  selectedNodeId: null,
  filters: {},
  loading: false,

  loadGraph: async () => {
    set({ loading: true });
    try {
      const [graph, stats] = await Promise.all([
        api.getKnowledgeGraph(),
        api.getKnowledgeStats(),
      ]);
      set({ graph, stats, loading: false });
    } catch {
      set({ loading: false });
    }
  },

  loadStats: async () => {
    try {
      const stats = await api.getKnowledgeStats();
      set({ stats });
    } catch {
      // ignore
    }
  },

  selectNode: (nodeId) => set({ selectedNodeId: nodeId }),

  setFilters: (filters) => set({ filters }),

  curateNode: async (nodeId, action, edits) => {
    await api.curateKnowledgeNode(nodeId, { action, edits });
    // Reload graph after curation
    const [graph, stats] = await Promise.all([
      api.getKnowledgeGraph(),
      api.getKnowledgeStats(),
    ]);
    set({ graph, stats, selectedNodeId: action === "reject" ? null : nodeId });
  },
}));
