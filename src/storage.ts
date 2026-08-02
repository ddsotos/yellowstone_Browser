import { GameState, RecentPlacement } from "./game/types";
import { V2TrackingState } from "./game/v2Tracking";
import type { ModelId } from "./ai/client";

export type Difficulty = "standard" | "expert";
export type AssistMode = "none" | "preplay" | "analysis";

export interface Settings {
  difficulty: Difficulty;
  assistMode: AssistMode;
  modelId?: ModelId;
  modelIds: ModelId[];
  npcModelId: ModelId;
}

export interface SavedGame {
  version: 2;
  state: GameState;
  history: RecentPlacement[];
  settings: Settings;
  v2Tracking: V2TrackingState;
  savedAt: string;
}

const KEY = "yellowstone-browser:game:v2";

export const loadGame = (): SavedGame | null => {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SavedGame;
    if (parsed.version !== 2 || parsed.state.schemaVersion !== 1) return null;
    return parsed;
  } catch {
    return null;
  }
};

export const saveGame = (
  state: GameState,
  history: RecentPlacement[],
  settings: Settings,
  v2Tracking: V2TrackingState,
): void => {
  const value: SavedGame = {
    version: 2,
    state,
    history,
    settings,
    v2Tracking,
    savedAt: new Date().toISOString(),
  };
  localStorage.setItem(KEY, JSON.stringify(value));
};

export const clearSavedGame = (): void => {
  localStorage.removeItem(KEY);
  localStorage.removeItem("yellowstone-browser:game:v1");
};
