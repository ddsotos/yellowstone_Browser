import { GameState, RecentPlacement } from "./game/types";

export type Difficulty = "standard" | "expert";
export type AssistMode = "none" | "analysis";

export interface Settings {
  difficulty: Difficulty;
  assistMode: AssistMode;
}

export interface SavedGame {
  version: 1;
  state: GameState;
  history: RecentPlacement[];
  settings: Settings;
  savedAt: string;
}

const KEY = "yellowstone-browser:game:v1";

export const loadGame = (): SavedGame | null => {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SavedGame;
    if (parsed.version !== 1 || parsed.state.schemaVersion !== 1) return null;
    return parsed;
  } catch {
    return null;
  }
};

export const saveGame = (
  state: GameState,
  history: RecentPlacement[],
  settings: Settings,
): void => {
  const value: SavedGame = {
    version: 1,
    state,
    history,
    settings,
    savedAt: new Date().toISOString(),
  };
  localStorage.setItem(KEY, JSON.stringify(value));
};

export const clearSavedGame = (): void => localStorage.removeItem(KEY);
