import { create } from "zustand";
import type { ContextSearchRequest, ContextSearchResult, ContextSource } from "@council/shared";
import { CONTEXT_SOURCES } from "@council/shared";
import * as api from "../services/api";

interface SearchStore {
  query: string;
  sources: ContextSource[];
  timeWindowDays: number;
  result: ContextSearchResult | null;
  loading: boolean;
  error: string | null;

  setQuery: (q: string) => void;
  toggleSource: (s: ContextSource) => void;
  setTimeWindowDays: (days: number) => void;
  run: (overrides?: Partial<ContextSearchRequest>) => Promise<void>;
  reset: () => void;
}

export const useSearchStore = create<SearchStore>((set, get) => ({
  query: "",
  sources: [...CONTEXT_SOURCES],
  timeWindowDays: 90,
  result: null,
  loading: false,
  error: null,

  setQuery: (query) => set({ query }),

  toggleSource: (s) => {
    const current = get().sources;
    const next = current.includes(s) ? current.filter((x) => x !== s) : [...current, s];
    set({ sources: next });
  },

  setTimeWindowDays: (timeWindowDays) => set({ timeWindowDays }),

  run: async (overrides) => {
    const { query, sources, timeWindowDays } = get();
    const trimmed = (overrides?.query ?? query).trim();
    if (!trimmed) return;
    set({ loading: true, error: null });
    try {
      const result = await api.searchContext({
        query: trimmed,
        sources: overrides?.sources ?? (sources.length < CONTEXT_SOURCES.length ? sources : undefined),
        time_window_days: overrides?.time_window_days ?? timeWindowDays,
        ...overrides,
      });
      set({ result, loading: false });
    } catch (err) {
      set({ error: (err as Error).message, loading: false });
    }
  },

  reset: () => set({ query: "", result: null, error: null }),
}));
