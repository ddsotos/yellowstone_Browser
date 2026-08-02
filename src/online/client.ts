import { GameState, Action, Card, RecentPlacement } from "../game/types";
import { V2TrackingState } from "../game/v2Tracking";
import { Difficulty } from "../storage";
import type { ModelId } from "../ai/client";

export interface OnlineSession {
  id: string;
  name: string;
}

export interface OnlineSeat {
  index: number;
  kind: "human" | "cpu";
  name: string;
  sessionId: string | null;
  connected: boolean;
}

export interface OnlineTurnSummary {
  playerIndex: number;
  cards: Card[];
  negativeCardDelta: number;
}

export interface OnlineGame {
  id: string;
  name: string;
  status: "waiting" | "active";
  hostSessionId: string;
  createdAt: string;
  startedAt: string | null;
  cpuDifficulty: Difficulty;
  cpuModelId: ModelId;
  showWinRates: boolean;
  seats: (OnlineSeat | null)[];
  state: GameState | null;
  history: RecentPlacement[];
  v2Tracking: V2TrackingState | null;
  lastTurns: (OnlineTurnSummary | null)[];
  revision: number;
}

export interface OnlineLobby {
  activeGameId: string | null;
  games: OnlineGame[];
}

const SESSION_KEY = "yellowstone-browser:online-session-id";

export const onlineEnabled = (): boolean =>
  new URLSearchParams(window.location.search).get("online") === "1";

export const savedSessionId = (): string | null =>
  localStorage.getItem(SESSION_KEY);

export const saveSessionId = (sessionId: string): void => {
  localStorage.setItem(SESSION_KEY, sessionId);
};

export const clearSessionId = (): void => {
  localStorage.removeItem(SESSION_KEY);
};

const requestJson = async <T>(path: string, body?: unknown): Promise<T> => {
  const response = await fetch(path, {
    method: body ? "POST" : "GET",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? "online request failed");
  return value as T;
};

export const bootstrapOnline = (sessionId: string | null) =>
  requestJson<{ session: OnlineSession | null; lobby: OnlineLobby }>(
    `/api/online/bootstrap${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ""}`,
  );

export const loginOnline = (name: string, sessionId: string | null) =>
  requestJson<{ session: OnlineSession; lobby: OnlineLobby }>("/api/online/login", {
    name,
    sessionId,
  });

export const createOnlineGame = (
  sessionId: string,
  name: string,
  cpuDifficulty: Difficulty,
  cpuModelId: ModelId,
  showWinRates: boolean,
) =>
  requestJson<{ lobby: OnlineLobby }>("/api/online/create", {
    sessionId,
    name,
    cpuDifficulty,
    cpuModelId,
    showWinRates,
  });

export const joinOnlineGame = (sessionId: string, gameId: string) =>
  requestJson<{ lobby: OnlineLobby }>("/api/online/join", { sessionId, gameId });

export const setOnlineCpuDifficulty = (
  sessionId: string,
  gameId: string,
  cpuDifficulty: Difficulty,
) =>
  requestJson<{ lobby: OnlineLobby }>("/api/online/cpu-difficulty", {
    sessionId,
    gameId,
    cpuDifficulty,
  });

export const setOnlineCpuModel = (
  sessionId: string,
  gameId: string,
  cpuModelId: ModelId,
) =>
  requestJson<{ lobby: OnlineLobby }>("/api/online/cpu-model", {
    sessionId,
    gameId,
    cpuModelId,
  });

export const setOnlineWinRateDisplay = (
  sessionId: string,
  gameId: string,
  showWinRates: boolean,
) =>
  requestJson<{ lobby: OnlineLobby }>("/api/online/win-rate-display", {
    sessionId,
    gameId,
    showWinRates,
  });

export const kickOnlineSeat = (
  sessionId: string,
  gameId: string,
  seatIndex: number,
) =>
  requestJson<{ lobby: OnlineLobby }>("/api/online/kick", {
    sessionId,
    gameId,
    seatIndex,
  });

export const deleteOnlineGame = (sessionId: string, gameId: string) =>
  requestJson<{ lobby: OnlineLobby }>("/api/online/delete", {
    sessionId,
    gameId,
  });

export const startOnlineGame = (sessionId: string, gameId: string) =>
  requestJson<{ lobby: OnlineLobby }>("/api/online/start", { sessionId, gameId });

export const submitOnlineTurn = (
  sessionId: string,
  gameId: string,
  revision: number,
  actions: Action[],
) =>
  requestJson<{ lobby: OnlineLobby }>("/api/online/submit-turn", {
    sessionId,
    gameId,
    revision,
    actions,
  });

export const submitOnlineCpuTurn = (
  sessionId: string,
  gameId: string,
  revision: number,
  actions: Action[],
) =>
  requestJson<{ lobby: OnlineLobby }>("/api/online/submit-cpu-turn", {
    sessionId,
    gameId,
    revision,
    actions,
  });
