"use client";

import { create } from "zustand";
import { ApiError, listExecutions } from "@/lib/execution/api";
import type { ExecutionView } from "@/lib/execution/types";

/**
 * Run history cache for the executions list and dashboard.
 *
 * One fetch/refresh path shared by every screen that shows history;
 * rows are real database records (seed rows are marked via `source`),
 * never local demo fixtures.
 */

interface ExecutionsStore {
  rows: ExecutionView[];
  total: number;
  loading: boolean;
  loaded: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export const useExecutionsStore = create<ExecutionsStore>((set, get) => ({
  rows: [],
  total: 0,
  loading: false,
  loaded: false,
  error: null,

  refresh: async () => {
    if (get().loading) return;
    set({ loading: true, error: null });
    try {
      const { executions, total } = await listExecutions({ limit: 200 });
      set({ rows: executions, total, loading: false, loaded: true, error: null });
    } catch (error) {
      set({
        loading: false,
        loaded: true,
        error:
          error instanceof ApiError
            ? error.message
            : "Could not load execution history.",
      });
    }
  },
}));

export function hasActiveRows(rows: ExecutionView[]): boolean {
  return rows.some(
    (row) => row.status === "queued" || row.status === "running" || row.status === "waiting",
  );
}
