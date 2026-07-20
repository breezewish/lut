import type { QueueItem } from "../types";

export interface QueueUndo {
  items: QueueItem[];
  activeId?: string;
  message: string;
}

export interface QueueState {
  items: QueueItem[];
  activeId?: string;
  selectedIds: Set<string>;
}

export interface SelectionModifiers {
  additive: boolean;
  range: boolean;
}

export function uniqueNewFiles(items: QueueItem[], files: File[]): File[] {
  const ids = new Set(items.map(({ id }) => id));
  return files.filter((file) => {
    const id = `${file.name}:${file.size}:${file.lastModified}`;
    if (ids.has(id)) return false;
    ids.add(id);
    return true;
  });
}

export type QueueAction =
  | { type: "update"; id: string; patch: Partial<QueueItem> }
  | {
      type: "patch-selected";
      patch: Partial<Pick<QueueItem, "ev" | "temperature" | "tint" | "lutId">>;
    }
  | {
      type: "select";
      id: string;
      modifiers: SelectionModifiers;
    }
  | { type: "activate"; id: string }
  | {
      type: "add";
      files: File[];
      thumbUrls: Map<string, string>;
      defaultLutId: string;
    }
  | { type: "remove"; id: string }
  | { type: "restore"; undo: QueueUndo };

export const INITIAL_QUEUE: QueueState = {
  items: [],
  selectedIds: new Set(),
};

export function queueReducer(
  state: QueueState,
  action: QueueAction,
): QueueState {
  if (action.type === "update") {
    return {
      ...state,
      items: state.items.map((item) =>
        item.id === action.id ? { ...item, ...action.patch } : item,
      ),
    };
  }
  if (action.type === "patch-selected") {
    return {
      ...state,
      items: state.items.map((item) =>
        state.selectedIds.has(item.id) ? { ...item, ...action.patch } : item,
      ),
    };
  }
  if (action.type === "select") {
    if (action.modifiers.range && state.activeId) {
      const from = state.items.findIndex((item) => item.id === state.activeId);
      const to = state.items.findIndex((item) => item.id === action.id);
      if (from >= 0 && to >= 0) {
        const [lo, hi] = from < to ? [from, to] : [to, from];
        return {
          ...state,
          activeId: action.id,
          selectedIds: new Set(
            state.items.slice(lo, hi + 1).map(({ id }) => id),
          ),
        };
      }
    }
    if (action.modifiers.additive) {
      const selectedIds = new Set(state.selectedIds);
      if (selectedIds.has(action.id)) selectedIds.delete(action.id);
      else selectedIds.add(action.id);
      if (selectedIds.size === 0) selectedIds.add(action.id);
      return {
        ...state,
        activeId: selectedIds.has(action.id)
          ? action.id
          : selectedIds.values().next().value,
        selectedIds,
      };
    }
    return { ...state, activeId: action.id, selectedIds: new Set([action.id]) };
  }
  if (action.type === "activate") {
    return {
      ...state,
      activeId: action.id,
      selectedIds: new Set([action.id]),
    };
  }
  if (action.type === "add") {
    const additions: QueueItem[] = uniqueNewFiles(
      state.items,
      action.files,
    ).map((file) => {
      const id = `${file.name}:${file.size}:${file.lastModified}`;
      return {
        id,
        file,
        status: "queued",
        ev: 0,
        temperature: 0,
        tint: 0,
        lutId: action.defaultLutId,
        thumbUrl: action.thumbUrls.get(id),
      };
    });
    if (additions.length === 0) return state;
    return {
      items: [...state.items, ...additions],
      activeId: additions[0].id,
      selectedIds: new Set([additions[0].id]),
    };
  }
  if (action.type === "remove") {
    const items = state.items.filter(({ id }) => id !== action.id);
    const selectedIds = new Set(state.selectedIds);
    selectedIds.delete(action.id);
    if (selectedIds.size === 0 && items[0]) selectedIds.add(items[0].id);
    return {
      items,
      selectedIds,
      activeId: state.activeId === action.id ? items[0]?.id : state.activeId,
    };
  }
  const currentIds = new Set(state.items.map(({ id }) => id));
  return {
    items: [
      ...action.undo.items.filter(({ id }) => !currentIds.has(id)),
      ...state.items,
    ],
    activeId: action.undo.activeId ?? state.activeId,
    selectedIds: action.undo.activeId
      ? new Set([action.undo.activeId])
      : state.selectedIds,
  };
}
