import { create } from "zustand";
import type { Project, ProjectContextUpdate } from "@pim/shared";
import * as api from "../services/api";
import type { ContextUpdateInput, ProjectSubmitResult } from "../services/api";

interface ProjectStore {
  project: Project | null;
  contextUpdates: ProjectContextUpdate[];
  loading: boolean;
  error: string | null;

  loadProject: (projectId: string) => Promise<void>;
  submitProjectContextUpdate: (
    input: ContextUpdateInput,
  ) => Promise<ProjectSubmitResult | null>;
  retractProjectContextUpdate: (updateId: string) => Promise<void>;
}

export const useProjectStore = create<ProjectStore>((set, get) => ({
  project: null,
  contextUpdates: [],
  loading: false,
  error: null,

  loadProject: async (projectId: string) => {
    set({ loading: true, error: null });
    try {
      const project = await api.getProject(projectId);
      if (!project) {
        set({
          project: null,
          contextUpdates: [],
          loading: false,
          error: "Project not found",
        });
        return;
      }
      const contextUpdates = await api.getProjectContextUpdates(projectId);
      set({ project, contextUpdates, loading: false });
    } catch (err) {
      set({
        loading: false,
        error: err instanceof Error ? err.message : "Failed to load project",
      });
    }
  },

  submitProjectContextUpdate: async (input: ContextUpdateInput) => {
    const { project, contextUpdates } = get();
    if (!project) return null;
    const result = await api.submitProjectContextUpdate(project.project_id, input);
    set({ contextUpdates: [result.update, ...contextUpdates] });
    return result;
  },

  retractProjectContextUpdate: async (updateId: string) => {
    const { project, contextUpdates } = get();
    if (!project) return;
    await api.retractProjectContextUpdate(project.project_id, updateId);
    set({ contextUpdates: contextUpdates.filter((u) => u.id !== updateId) });
  },
}));
