import { useEffect, useMemo, useRef, useState } from "react";
import {
  AiTimeoutError,
  evaluateAllModels,
  evaluatePreplayBefore,
  MODEL_SPECS,
  ModelId,
  ModelAnalysis,
  PLAYABLE_MODEL_SPECS,
  selectBestTurn,
  warmAi,
} from "./ai/client";
import { Board } from "./components/Board";
import { Hand } from "./components/Hand";
import { Details } from "./Details";
import { chooseHeuristicAction, placementSortKey } from "./game/bot";
import {
  applyKnownLegalAction,
  createInitialState,
  framePositions,
  legalActions,
  refillActions,
} from "./game/game";
import {
  Action,
  GameState,
  PlaceCardAction,
  RecentPlacement,
  RefillAction,
  positionKey,
} from "./game/types";
import {
  applyActionTrackingHistory,
  candidateGroupSignature,
  candidateRefillDecision,
  completeHumanCandidate,
  enumerateTurnCandidates,
  playedCardsSignature,
  TurnEvaluation,
} from "./game/value";
import {
  createV2Tracking,
  observeV2Action,
  replayV2Actions,
} from "./game/v2Tracking";
import {
  AssistMode,
  clearSavedGame,
  Difficulty,
  loadGame,
  saveGame,
  Settings,
} from "./storage";
import {
  bootstrapOnline,
  clearSessionId,
  createOnlineGame,
  deleteOnlineGame,
  joinOnlineGame,
  kickOnlineSeat,
  loginOnline,
  OnlineGame,
  OnlineLobby,
  OnlineSession,
  OnlineTurnSummary,
  onlineEnabled,
  savedSessionId,
  saveSessionId,
  setOnlineCpuDifficulty,
  setOnlineCpuModel,
  startOnlineGame,
  submitOnlineCpuTurn,
  submitOnlineTurn,
} from "./online/client";

type Screen = "home" | "game" | "details";
type Preview = "own" | `${string}:own` | `${string}:ai-${number}`;

interface Comparison {
  models: ModelAnalysis[];
}

interface PreplayOnly {
  status: "loading" | "ok" | "error";
  label: string;
  probability?: number;
  error?: string;
}

const seatName = (
  index: number,
  lobby: OnlineLobby | null,
  session: OnlineSession | null,
): string => {
  const seat = lobby?.games
    .flatMap((game) => game.seats)
    .find((candidate) => candidate?.index === index && candidate.sessionId === session?.id);
  return seat?.name ?? (index === 0 ? "あなた" : `NPC ${index}`);
};

const defaultSettings: Settings = {
  difficulty: "standard",
  assistMode: "none",
  npcModelId: "v1-generation0-epoch002",
  modelIds: [
    "v1-generation0-epoch002",
    "v2-generation0-epoch001",
    "action-delta-selected",
    "v1-new-88966-epoch001",
    "v1-board-centered-explore-none-76919-epoch001",
  ],
};

const publicModelSpecs = MODEL_SPECS.filter(
  (spec) => !spec.encoder.startsWith("privileged"),
);

const sanitizePublicModelIds = (modelIds: ModelId[]): ModelId[] => {
  const allowed = new Set(publicModelSpecs.map((spec) => spec.id));
  const selected = modelIds.filter((id) => allowed.has(id)).slice(0, 5);
  return selected.length
    ? selected
    : defaultSettings.modelIds.filter((id) => allowed.has(id));
};

const sanitizePlayableModelId = (modelId: ModelId | undefined): ModelId =>
  PLAYABLE_MODEL_SPECS.find((spec) => spec.id === modelId)?.id ??
  defaultSettings.npcModelId;

const cardName = (action: PlaceCardAction, before: GameState): string => {
  const card = before.players[before.currentPlayerIndex].hand[action.handIndex];
  const colors = { red: "赤", blue: "青", green: "緑", yellow: "黄" };
  return `${colors[card.color]}${card.rankIndex + 1}`;
};

const turnSummaryText = (turn: OnlineTurnSummary | null | undefined): string => {
  if (!turn) return "直近プレイ なし / 受取失点 0枚";
  const colors = { red: "赤", blue: "青", green: "緑", yellow: "黄" };
  const cards = turn.cards
    .map((card) => `${colors[card.color]}${card.rankIndex + 1}`)
    .join("・");
  return `直近 ${cards || "なし"} / 受取失点 ${turn.negativeCardDelta}枚`;
};

// Candidate states include the selected refill. For the hand preview, keep the
// decision boundary visible: remove played cards, but do not append refilled cards.
const handBeforeRefill = (start: GameState, actions: Action[]) => {
  const hand = [...start.players[start.currentPlayerIndex].hand];
  for (const action of actions) {
    if (action.type !== "place") continue;
    if (action.handIndex >= 0 && action.handIndex < hand.length) {
      hand.splice(action.handIndex, 1);
    }
  }
  return hand;
};

const describePlan = (start: GameState, actions: Action[]): string => {
  let state = start;
  const labels: string[] = [];
  let hasRefill = false;
  actions.forEach((action) => {
    if (action.type === "place") {
      labels.push(cardName(action, state));
    } else if (action.type === "refill") {
      hasRefill = true;
      labels.push(
        action.source === "deck"
          ? "山札から補充"
          : action.source === "negative_cards"
            ? "マイナスから補充"
            : "補充なし",
      );
    }
    state = applyKnownLegalAction(state, action);
  });
  if (!hasRefill) labels.push("補充なし");
  return labels.join(" → ");
};

const roundedProbability = (probability: number): string =>
  `${Math.round(probability * 100)}%`;
const formattedScore = (
  value: number,
  kind: "probability" | "delta",
): string =>
  kind === "delta"
    ? `${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)}pt`
    : roundedProbability(value);

const downloadJson = (filename: string, value: unknown): void => {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(value, null, 2)], {
      type: "application/json;charset=utf-8",
    }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
};

export default function App() {
  const isOnline = useMemo(onlineEnabled, []);
  const savedAtStart = useMemo(loadGame, []);
  const initialSettings = useMemo((): Settings => {
    const saved = savedAtStart?.settings;
    if (!saved) return defaultSettings;
    const modelIds =
      saved.modelIds?.length
        ? saved.modelIds
        : saved.modelId
          ? [saved.modelId]
          : defaultSettings.modelIds;
    return {
      ...defaultSettings,
      ...saved,
      npcModelId: sanitizePlayableModelId(saved.npcModelId ?? saved.modelId),
      modelIds: modelIds.slice(0, 5),
    };
  }, [savedAtStart]);
  const [screen, setScreen] = useState<Screen>("home");
  const [settings, setSettings] = useState<Settings>(initialSettings);
  const [state, setState] = useState<GameState | null>(
    savedAtStart?.state ?? null,
  );
  const [history, setHistory] = useState<RecentPlacement[]>(
    savedAtStart?.history ?? [],
  );
  const [v2Tracking, setV2Tracking] = useState(
    savedAtStart?.v2Tracking ?? createV2Tracking(4),
  );
  const [pendingState, setPendingState] = useState<GameState | null>(null);
  const [pendingActions, setPendingActions] = useState<PlaceCardAction[]>([]);
  const [selectedHandIndex, setSelectedHandIndex] = useState<number | null>(null);
  const [frameChoices, setFrameChoices] = useState<PlaceCardAction[]>([]);
  const [selectedFrameAction, setSelectedFrameAction] =
    useState<PlaceCardAction | null>(null);
  const [manualFrameSelection, setManualFrameSelection] = useState(false);
  const [plannedRefill, setPlannedRefill] = useState<RefillAction | null>(null);
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const [preplayOnly, setPreplayOnly] = useState<PreplayOnly | null>(null);
  const [preview, setPreview] = useState<Preview>("own");
  const [message, setMessage] = useState("");
  const [thinking, setThinking] = useState(false);
  const [onlineSession, setOnlineSession] = useState<OnlineSession | null>(null);
  const [onlineLobby, setOnlineLobby] = useState<OnlineLobby | null>(null);
  const [onlineName, setOnlineName] = useState("");
  const [onlineMessage, setOnlineMessage] = useState("");
  const npcRunning = useRef(false);
  const onlineCpuRunning = useRef(false);
  const activeModelIds = isOnline
    ? sanitizePublicModelIds(settings.modelIds)
    : settings.modelIds;
  const primaryPlayableModelId = sanitizePlayableModelId(settings.npcModelId);
  const isPreplayModel = (model: ModelAnalysis) =>
    model.spec.encoder.startsWith("privileged");

  const activeOnlineGame = onlineLobby?.games.find(
    (game) => game.id === onlineLobby.activeGameId,
  );
  const ownOnlineSeat = activeOnlineGame?.seats.find(
    (seat) => seat?.kind === "human" && seat.sessionId === onlineSession?.id,
  );
  const viewPlayerIndex = ownOnlineSeat?.index ?? 0;
  const onlineCanHost =
    activeOnlineGame?.hostSessionId === onlineSession?.id &&
    activeOnlineGame?.status === "waiting";
  const currentTurnName = activeOnlineGame?.seats[state?.currentPlayerIndex ?? 0]?.name;

  useEffect(() => {
    if (state && !isOnline) saveGame(state, history, settings, v2Tracking);
  }, [state, history, settings, v2Tracking, isOnline]);

  useEffect(() => {
    if (!isOnline) return;
    let disposed = false;
    bootstrapOnline(savedSessionId())
      .then((value) => {
        if (disposed) return;
        setOnlineSession(value.session);
        setOnlineLobby(value.lobby);
        setOnlineName(value.session?.name ?? "");
      })
      .catch((error) => {
        if (!disposed) setOnlineMessage(String(error));
      });
    return () => {
      disposed = true;
    };
  }, [isOnline]);

  useEffect(() => {
    if (!isOnline || !onlineSession) return;
    const source = new EventSource(
      `/api/online/events?sessionId=${encodeURIComponent(onlineSession.id)}`,
    );
    source.onmessage = (event) => {
      setOnlineLobby(JSON.parse(event.data) as OnlineLobby);
    };
    source.addEventListener("session", (event) => {
      const session = JSON.parse((event as MessageEvent).data) as OnlineSession;
      setOnlineSession(session);
      saveSessionId(session.id);
    });
    source.onerror = () => {
      setOnlineMessage("オンライン接続が切れました。再接続中です。");
    };
    return () => source.close();
  }, [isOnline, onlineSession?.id]);

  useEffect(() => {
    if (!isOnline || !onlineSession) return;
    let disposed = false;
    const refresh = async () => {
      try {
        const value = await bootstrapOnline(onlineSession.id);
        if (disposed) return;
        if (value.session) {
          setOnlineSession(value.session);
          saveSessionId(value.session.id);
        }
        setOnlineLobby(value.lobby);
      } catch {
        // EventSource is primary; polling is a best-effort fallback.
      }
    };
    const interval = window.setInterval(() => void refresh(), 2000);
    return () => {
      disposed = true;
      window.clearInterval(interval);
    };
  }, [isOnline, onlineSession?.id]);

  useEffect(() => {
    if (!isOnline || !activeOnlineGame?.state || !activeOnlineGame.v2Tracking) {
      return;
    }
    setState(activeOnlineGame.state);
    setHistory(activeOnlineGame.history);
    setV2Tracking(activeOnlineGame.v2Tracking);
    if (activeOnlineGame.state.currentPlayerIndex !== viewPlayerIndex) {
      setPendingState(null);
      setPendingActions([]);
      setSelectedHandIndex(null);
      setFrameChoices([]);
      setSelectedFrameAction(null);
      setPlannedRefill(null);
      setComparison(null);
      setPreview("own");
    }
  }, [
    isOnline,
    activeOnlineGame?.id,
    activeOnlineGame?.revision,
    viewPlayerIndex,
  ]);

  useEffect(() => {
    if (
      screen === "game" &&
      (settings.assistMode === "analysis" ||
        settings.difficulty === "expert")
    ) {
      warmAi(primaryPlayableModelId);
    }
  }, [screen, settings.assistMode, settings.difficulty, primaryPlayableModelId]);

  useEffect(() => {
    if (
      state?.phase === "play" &&
      state.currentPlayerIndex === viewPlayerIndex &&
      state.cardsPlayedThisTurn === 0
    ) {
      setPendingState(state);
      setPendingActions([]);
      setSelectedHandIndex(null);
      setFrameChoices([]);
      setSelectedFrameAction(null);
      setPlannedRefill(null);
      setComparison(null);
      setPreplayOnly(null);
    }
  }, [state, viewPlayerIndex]);

  useEffect(() => {
    if (
      !state ||
      state.phase !== "play" ||
      state.currentPlayerIndex !== viewPlayerIndex ||
      state.cardsPlayedThisTurn !== 0 ||
      settings.assistMode === "none"
    ) {
      return;
    }
    let disposed = false;
    setPreplayOnly({ status: "loading", label: "Pre-play" });
    evaluatePreplayBefore(viewPlayerIndex, state, history)
      .then((value) => {
        if (disposed) return;
        setPreplayOnly({
          status: "ok",
          label: value.spec.label,
          probability: value.probability,
        });
      })
      .catch((error) => {
        if (disposed) return;
        setPreplayOnly({
          status: "error",
          label: "Pre-play",
          error: error instanceof Error ? error.message : String(error),
        });
      });
    return () => {
      disposed = true;
    };
  }, [
    state?.randomState,
    state?.currentPlayerIndex,
    state?.cardsPlayedThisTurn,
    settings.assistMode,
    viewPlayerIndex,
    history,
  ]);

  useEffect(() => {
    if (
      !isOnline ||
      !onlineSession ||
      !activeOnlineGame?.state ||
      !activeOnlineGame.v2Tracking ||
      activeOnlineGame.status !== "active" ||
      activeOnlineGame.cpuDifficulty !== "expert" ||
      onlineCpuRunning.current
    ) {
      return;
    }
    const cpuState = activeOnlineGame.state;
    const cpuTracking = activeOnlineGame.v2Tracking;
    if (!cpuState || !cpuTracking) return;
    const seat = activeOnlineGame.seats[cpuState.currentPlayerIndex];
    const joined = activeOnlineGame.seats.some(
      (value) => value?.kind === "human" && value.sessionId === onlineSession.id,
    );
    if (seat?.kind !== "cpu" || !joined) return;
    onlineCpuRunning.current = true;
    const run = async () => {
      let actions: Action[] = [];
      const playerIndex = cpuState.currentPlayerIndex;
      try {
        if (
          cpuState.phase === "play" &&
          cpuState.cardsPlayedThisTurn === 0 &&
          legalActions(cpuState).some((action) => action.type === "place")
        ) {
          const candidates = enumerateTurnCandidates(cpuState, activeOnlineGame.history);
          const best = await selectBestTurn(
            candidates,
            playerIndex,
            cpuState,
            cpuTracking,
            activeOnlineGame.history,
            sanitizePlayableModelId(activeOnlineGame.cpuModelId),
          );
          actions = best.candidate.actions;
        }
      } catch {
        actions = [];
      }
      if (!actions.length) {
        let nextState = cpuState;
        const fallbackActions: Action[] = [];
        while (
          nextState.phase !== "game_over" &&
          nextState.currentPlayerIndex === playerIndex
        ) {
          const action = chooseHeuristicAction(nextState);
          if (!action) break;
          fallbackActions.push(action);
          nextState = applyKnownLegalAction(nextState, action);
        }
        actions = fallbackActions;
      }
      try {
        const value = await submitOnlineCpuTurn(
          onlineSession.id,
          activeOnlineGame.id,
          activeOnlineGame.revision,
          actions,
        );
        setOnlineLobby(value.lobby);
      } catch {
        // Another browser may have submitted the same CPU turn first.
      } finally {
        onlineCpuRunning.current = false;
      }
    };
    void run();
  }, [
    isOnline,
    onlineSession?.id,
    activeOnlineGame?.id,
    activeOnlineGame?.revision,
    activeOnlineGame?.status,
    activeOnlineGame?.cpuDifficulty,
    activeOnlineGame?.cpuModelId,
  ]);

  useEffect(() => {
    if (
      isOnline ||
      !state ||
      state.phase === "game_over" ||
      state.currentPlayerIndex === 0 ||
      npcRunning.current
    ) {
      return;
    }
    npcRunning.current = true;
    const run = async () => {
      setThinking(true);
      setMessage(`NPC ${state.currentPlayerIndex} が考えています…`);
      let nextState = state;
      let nextHistory = history;
      let nextV2Tracking = v2Tracking;
      const playerIndex = state.currentPlayerIndex;
      try {
        if (
          settings.difficulty === "expert" &&
          nextState.phase === "play" &&
          nextState.cardsPlayedThisTurn === 0 &&
          legalActions(nextState).some((action) => action.type === "place")
        ) {
          const candidates = enumerateTurnCandidates(nextState, nextHistory);
          const best = await selectBestTurn(
            candidates,
            playerIndex,
            nextState,
            nextV2Tracking,
            nextHistory,
            primaryPlayableModelId,
          );
          nextV2Tracking = replayV2Actions(
            nextState,
            best.candidate.actions,
            nextV2Tracking,
          ).tracking;
          nextState = best.candidate.state;
          nextHistory = best.candidate.history;
        } else {
          while (
            nextState.phase !== "game_over" &&
            nextState.currentPlayerIndex === playerIndex
          ) {
            const action = chooseHeuristicAction(nextState);
            if (!action) break;
            const applied = applyActionTrackingHistory(
              nextState,
              action,
              nextHistory,
            );
            nextV2Tracking = observeV2Action(
              nextV2Tracking,
              nextState,
              action,
              applied.state,
            );
            nextState = applied.state;
            nextHistory = applied.history;
          }
        }
        while (
          nextState.phase !== "game_over" &&
          nextState.currentPlayerIndex === playerIndex
        ) {
          const action = chooseHeuristicAction(nextState);
          if (!action) break;
          const applied = applyActionTrackingHistory(
            nextState,
            action,
            nextHistory,
          );
          nextV2Tracking = observeV2Action(
            nextV2Tracking,
            nextState,
            action,
            applied.state,
          );
          nextState = applied.state;
          nextHistory = applied.history;
        }
        setMessage("");
      } catch (error) {
        if (error instanceof AiTimeoutError) {
          setMessage("10秒を超えたため、このターンは通常NPCが代行しました。");
        } else {
          setMessage("強化AIを読み込めないため、このターンは通常NPCが代行しました。");
        }
        nextState = state;
        nextHistory = history;
        nextV2Tracking = v2Tracking;
        while (
          nextState.phase !== "game_over" &&
          nextState.currentPlayerIndex === playerIndex
        ) {
          const action = chooseHeuristicAction(nextState);
          if (!action) break;
          const applied = applyActionTrackingHistory(
            nextState,
            action,
            nextHistory,
          );
          nextV2Tracking = observeV2Action(
            nextV2Tracking,
            nextState,
            action,
            applied.state,
          );
          nextState = applied.state;
          nextHistory = applied.history;
        }
      } finally {
        setHistory(nextHistory);
        setV2Tracking(nextV2Tracking);
        setState(nextState);
        setThinking(false);
        npcRunning.current = false;
      }
    };
    void run();
  }, [
    isOnline,
    state,
    history,
    settings.difficulty,
    primaryPlayableModelId,
    v2Tracking,
  ]);

  const startNew = () => {
    if (state && !window.confirm("保存中の対局を上書きして新しく始めますか？")) {
      return;
    }
    const next = createInitialState(4);
    setState(next);
    setHistory([]);
    setV2Tracking(createV2Tracking(4));
    setScreen("game");
    setMessage("");
  };

  const login = async () => {
    setOnlineMessage("");
    try {
      const value = await loginOnline(onlineName, savedSessionId());
      setOnlineSession(value.session);
      saveSessionId(value.session.id);
      setOnlineLobby(value.lobby);
    } catch (error) {
      setOnlineMessage(error instanceof Error ? error.message : String(error));
    }
  };

  const createTable = async () => {
    if (!onlineSession) return;
    setOnlineMessage("");
    try {
      const value = await createOnlineGame(
        onlineSession.id,
        `${onlineSession.name} table`,
        "standard",
        settings.npcModelId,
      );
      setOnlineLobby(value.lobby);
    } catch (error) {
      setOnlineMessage(error instanceof Error ? error.message : String(error));
    }
  };

  const joinTable = async (game: OnlineGame) => {
    if (!onlineSession) return;
    setOnlineMessage("");
    try {
      const value = await joinOnlineGame(onlineSession.id, game.id);
      setOnlineLobby(value.lobby);
    } catch (error) {
      setOnlineMessage(error instanceof Error ? error.message : String(error));
    }
  };

  const updateTableCpuDifficulty = async (
    game: OnlineGame,
    cpuDifficulty: Difficulty,
  ) => {
    if (!onlineSession) return;
    setOnlineMessage("");
    try {
      const value = await setOnlineCpuDifficulty(
        onlineSession.id,
        game.id,
        cpuDifficulty,
      );
      setOnlineLobby(value.lobby);
    } catch (error) {
      setOnlineMessage(error instanceof Error ? error.message : String(error));
    }
  };

  const updateTableCpuModel = async (game: OnlineGame, cpuModelId: ModelId) => {
    if (!onlineSession) return;
    setOnlineMessage("");
    try {
      const value = await setOnlineCpuModel(onlineSession.id, game.id, cpuModelId);
      setOnlineLobby(value.lobby);
    } catch (error) {
      setOnlineMessage(error instanceof Error ? error.message : String(error));
    }
  };

  const startTable = async () => {
    if (!onlineSession || !activeOnlineGame) return;
    setOnlineMessage("");
    try {
      const value = await startOnlineGame(onlineSession.id, activeOnlineGame.id);
      setOnlineLobby(value.lobby);
      setScreen("game");
    } catch (error) {
      setOnlineMessage(error instanceof Error ? error.message : String(error));
    }
  };

  const kickSeat = async (seatIndex: number) => {
    if (!onlineSession || !activeOnlineGame) return;
    setOnlineMessage("");
    try {
      const value = await kickOnlineSeat(
        onlineSession.id,
        activeOnlineGame.id,
        seatIndex,
      );
      setOnlineLobby(value.lobby);
    } catch (error) {
      setOnlineMessage(error instanceof Error ? error.message : String(error));
    }
  };

  const deleteTable = async (game: OnlineGame) => {
    if (!onlineSession) return;
    if (!window.confirm("このゲームを中断して削除しますか？")) return;
    setOnlineMessage("");
    try {
      const value = await deleteOnlineGame(onlineSession.id, game.id);
      setOnlineLobby(value.lobby);
      if (activeOnlineGame?.id === game.id) {
        setState(null);
        setHistory([]);
        setV2Tracking(createV2Tracking(4));
        resetOwnMove();
        setScreen("home");
      }
    } catch (error) {
      setOnlineMessage(error instanceof Error ? error.message : String(error));
    }
  };

  if (screen === "details") {
    return <Details onBack={() => setScreen(state ? "game" : "home")} />;
  }

  if (isOnline && screen === "home") {
    return (
      <main className="home online-home">
        <p className="eyebrow">ONLINE PLAY</p>
        <h1>Yellowstone park</h1>
        <p className="lead">名前でログインして、同じローカルサーバー上の卓に参加します。</p>
        <div className="setup-card online-panel">
          <fieldset className="online-login">
            <legend>ログイン</legend>
            <input
              value={onlineName}
              placeholder="名前"
              onChange={(event) => setOnlineName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void login();
              }}
            />
            <button type="button" className="primary" onClick={() => void login()}>
              入る
            </button>
            {onlineSession && (
              <button
                type="button"
                onClick={() => {
                  clearSessionId();
                  setOnlineSession(null);
                }}
              >
                ログアウト
              </button>
            )}
          </fieldset>

          <fieldset>
            <legend>AI分析</legend>
            <label>
              <input
                type="radio"
                checked={settings.assistMode === "none"}
                onChange={() =>
                  setSettings((value) => ({ ...value, assistMode: "none" }))
                }
              />
              使わない
            </label>
            <label>
              <input
                type="radio"
                checked={settings.assistMode === "analysis"}
                onChange={() =>
                  setSettings((value) => ({ ...value, assistMode: "analysis" }))
                }
              />
              各モデル勝率を表示
            </label>
            <label>
              <input
                type="radio"
                checked={settings.assistMode === "preplay"}
                onChange={() =>
                  setSettings((value) => ({ ...value, assistMode: "preplay" }))
                }
              />
              Pre-play only
            </label>
          </fieldset>

          <fieldset className="model-picker">
            <legend>Online AI models ({activeModelIds.length}/5)</legend>
            <div className="model-options">
              {publicModelSpecs.map((spec) => (
                <label key={spec.id}>
                  <input
                    type="checkbox"
                    checked={activeModelIds.includes(spec.id)}
                    disabled={
                      !activeModelIds.includes(spec.id) &&
                      activeModelIds.length >= 5
                    }
                    onChange={(event) =>
                      setSettings((value) => {
                        const current = sanitizePublicModelIds(value.modelIds);
                        if (event.target.checked) {
                          return {
                            ...value,
                            modelIds: [...current, spec.id].slice(0, 5),
                          };
                        }
                        const next = current.filter((id) => id !== spec.id);
                        return {
                          ...value,
                          modelIds: next.length ? next : current,
                        };
                      })
                    }
                  />
                  <span>{spec.label}</span>
                </label>
              ))}
            </div>
          </fieldset>

          {onlineMessage && <p className="notice">{onlineMessage}</p>}
          <button
            type="button"
            className="primary"
            disabled={!onlineSession || Boolean(onlineLobby?.activeGameId)}
            onClick={() => void createTable()}
          >
            ゲームを作成
          </button>

          <section className="online-games">
            <h2>ゲーム一覧</h2>
            {!onlineLobby?.games.length && <p>募集中のゲームはありません。</p>}
            {onlineLobby?.games.map((game) => {
              const joined = game.seats.some(
                (seat) => seat?.sessionId === onlineSession?.id,
              );
              const canManageGame =
                game.hostSessionId === onlineSession?.id &&
                game.status === "waiting";
              const humanSeats = game.seats.filter((seat) => seat?.kind === "human");
              const canDeleteGame =
                game.hostSessionId === onlineSession?.id ||
                (Boolean(onlineSession) &&
                  humanSeats.length > 0 &&
                  humanSeats.every((seat) => seat && !seat.connected));
              return (
                <article key={game.id} className="online-game">
                  <header>
                    <strong>{game.name}</strong>
                    <span>{game.status === "waiting" ? "募集中" : "対局中"}</span>
                  </header>
                  <fieldset>
                    <legend>CPU difficulty</legend>
                    <label>
                      <input
                        type="radio"
                        checked={game.cpuDifficulty === "standard"}
                        disabled={!canManageGame}
                        onChange={() =>
                          void updateTableCpuDifficulty(game, "standard")
                        }
                      />
                      standard
                    </label>
                    <label>
                      <input
                        type="radio"
                        checked={game.cpuDifficulty === "expert"}
                        disabled={!canManageGame}
                        onChange={() =>
                          void updateTableCpuDifficulty(game, "expert")
                        }
                      />
                      expert
                    </label>
                  </fieldset>
                  <fieldset className="model-picker">
                    <legend>CPU model</legend>
                    <div className="model-options">
                      {publicModelSpecs.map((spec) => (
                        <label key={spec.id}>
                          <input
                            type="radio"
                            checked={game.cpuModelId === spec.id}
                            disabled={!canManageGame}
                            onChange={() => void updateTableCpuModel(game, spec.id)}
                          />
                          <span>{spec.label}</span>
                        </label>
                      ))}
                    </div>
                  </fieldset>
                  <div className="online-seats">
                    {game.seats.map((seat, index) => (
                      <span key={index} className={seat ? "filled" : ""}>
                        {seat
                          ? `${index}: ${seat.name}${seat.connected ? "" : " (切断)"}`
                          : `${index}: 空席`}
                        {onlineCanHost &&
                          seat?.kind === "human" &&
                          seat.sessionId !== onlineSession?.id && (
                            <button type="button" onClick={() => void kickSeat(index)}>
                              外す
                            </button>
                          )}
                      </span>
                    ))}
                  </div>
                  {game.status === "waiting" && (
                    <div className="online-actions">
                      <button
                        type="button"
                        disabled={!onlineSession || joined}
                        onClick={() => void joinTable(game)}
                      >
                        join
                      </button>
                      {game.hostSessionId === onlineSession?.id && (
                        <button
                          type="button"
                          className="primary"
                          onClick={() => void startTable()}
                        >
                          募集を止めて開始
                        </button>
                      )}
                    </div>
                  )}
                  {game.status === "active" && joined && (
                    <button
                      type="button"
                      className="primary"
                      onClick={() => setScreen("game")}
                    >
                      対局へ
                    </button>
                  )}
                  {canDeleteGame && (
                    <button
                      type="button"
                      className="danger"
                      onClick={() => void deleteTable(game)}
                    >
                      中断・削除
                    </button>
                  )}
                </article>
              );
            })}
          </section>
        </div>
      </main>
    );
  }

  if (screen === "home") {
    return (
      <main className="home">
        <p className="eyebrow">LOCAL DEVELOPMENT PREVIEW</p>
        <h1>Yellowstone park</h1>
        <p className="lead">
          色と数字を読み、3×3のエリアを組み替えるカード配置ゲーム。
        </p>
        <div className="setup-card">
          <fieldset>
            <legend>NPC難易度</legend>
            <label>
              <input
                type="radio"
                checked={settings.difficulty === "standard"}
                onChange={() =>
                  setSettings((value) => ({ ...value, difficulty: "standard" }))
                }
              />
              通常NPC
            </label>
            <label>
              <input
                type="radio"
                checked={settings.difficulty === "expert"}
                onChange={() =>
                  setSettings((value) => ({ ...value, difficulty: "expert" }))
                }
              />
              強化NPC
            </label>
          </fieldset>
          <fieldset className="model-picker">
            <legend>NPC model</legend>
            <div className="model-options">
              {PLAYABLE_MODEL_SPECS.map((spec) => (
                <label key={spec.id}>
                  <input
                    type="radio"
                    checked={settings.npcModelId === spec.id}
                    onChange={() =>
                      setSettings((value) => ({ ...value, npcModelId: spec.id }))
                    }
                  />
                  <span>{spec.label}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset>
            <legend>プレイモード</legend>
            <label>
              <input
                type="radio"
                checked={settings.assistMode === "none"}
                onChange={() =>
                  setSettings((value) => ({ ...value, assistMode: "none" }))
                }
              />
              勝率を見せない
            </label>
            <label>
              <input
                type="radio"
                checked={settings.assistMode === "analysis"}
                onChange={() =>
                  setSettings((value) => ({ ...value, assistMode: "analysis" }))
                }
              />
              AI分析モード
            </label>
            <label>
              <input
                type="radio"
                checked={settings.assistMode === "preplay"}
                onChange={() =>
                  setSettings((value) => ({ ...value, assistMode: "preplay" }))
                }
              />
              Pre-play only
            </label>
          </fieldset>
          <fieldset className="model-picker">
            <legend>AI models ({settings.modelIds.length}/5)</legend>
            <div className="model-options">
              {MODEL_SPECS.map((spec) => (
                <label key={spec.id}>
                  <input
                    type="checkbox"
                    checked={settings.modelIds.includes(spec.id)}
                    disabled={
                      !settings.modelIds.includes(spec.id) &&
                      settings.modelIds.length >= 5
                    }
                    onChange={(event) =>
                      setSettings((value) => {
                        if (event.target.checked) {
                          return {
                            ...value,
                            modelIds: [...value.modelIds, spec.id].slice(0, 5),
                          };
                        }
                        const next = value.modelIds.filter((id) => id !== spec.id);
                        return {
                          ...value,
                          modelIds: next.length ? next : value.modelIds,
                        };
                      })
                    }
                  />
                  <span>{spec.label}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <button type="button" className="primary" onClick={startNew}>
            新しいゲーム
          </button>
          {savedAtStart && state && (
            <button type="button" onClick={() => setScreen("game")}>
              続きから
            </button>
          )}
          <button type="button" className="text-button" onClick={() => setScreen("details")}>
            詳細説明
          </button>
        </div>
      </main>
    );
  }

  if (!state) return null;
  const human = state.players[viewPlayerIndex];
  const isHumanTurn =
    state.currentPlayerIndex === viewPlayerIndex && state.phase !== "game_over";
  const pending = pendingState ?? state;
  const selectedActions =
    selectedHandIndex === null
      ? []
      : legalActions(pending).filter(
          (action): action is PlaceCardAction =>
            action.type === "place" && action.handIndex === selectedHandIndex,
        );
  const legalPositionKeys = new Set(
    selectedActions.map((action) => positionKey(action.position)),
  );
  const visibleModels = comparison?.models.filter(
    (model) => !isPreplayModel(model),
  );
  const preplayModels = comparison?.models.filter(isPreplayModel) ?? [];
  const firstSuccessfulModel = visibleModels?.find(
    (model) => model.status === "ok",
  );
  const [previewModelId, previewChoice] =
    preview === "own" ? ["", "own"] : preview.split(":");
  const previewModel =
    visibleModels?.find((model) => model.spec.id === previewModelId) ??
    firstSuccessfulModel;
  const shownEvaluation =
    previewChoice === "own"
      ? previewModel?.own
      : previewModel?.top[Number(previewChoice?.slice(3))];
  const selectedPreplayEvaluation = (model: ModelAnalysis) => {
    const selected = shownEvaluation ?? model.own;
    if (!selected) return model.own;
    if (model.own?.candidate === selected.candidate) return model.own;
    return (
      model.all.find((evaluation) => evaluation.candidate === selected.candidate) ??
      model.own
    );
  };
  const placementPreviewBoard = selectedFrameAction
    ? (() => {
        const key = positionKey(selectedFrameAction.position);
        const card =
          pending.players[pending.currentPlayerIndex].hand[
            selectedFrameAction.handIndex
          ];
        return {
          ...pending.board,
          [key]: [...(pending.board[key] ?? []), card],
        };
      })()
    : pending.board;
  const shownBoard =
    shownEvaluation?.candidate.state.board ??
    placementPreviewBoard;
  const shownHand =
    shownEvaluation
      ? handBeforeRefill(state, shownEvaluation.candidate.actions)
      : pending.players[viewPlayerIndex].hand;
  const shownPlacements = (
    shownEvaluation?.candidate.actions ??
    (selectedFrameAction
      ? [...pendingActions, selectedFrameAction]
      : pendingActions)
  ).filter((action): action is PlaceCardAction => action.type === "place");
  const shownFrame =
    selectedFrameAction?.frame ?? shownPlacements.at(-1)?.frame;
  const frameAnchorKeys = new Set(
    frameChoices.map((action) =>
      positionKey({ x: action.frame.x + 2, y: action.frame.y + 2 }),
    ),
  );
  const penaltyPositionKeys = selectedFrameAction
    ? new Set(
        Object.keys(placementPreviewBoard).filter(
          (key) =>
            !framePositions(selectedFrameAction.frame)
              .map(positionKey)
              .includes(key),
        ),
      )
    : new Set<string>();
  const penaltyCardCount = [...penaltyPositionKeys].reduce(
    (count, key) => count + (placementPreviewBoard[key]?.length ?? 0),
    0,
  );
  const plannedRefillState =
    pending.phase === "refill"
      ? pending
      : pendingActions.length === 1 &&
          legalActions(pending).some((action) => action.type === "end_turn")
        ? (() => {
            const ended = applyKnownLegalAction(pending, {
              type: "end_turn",
            });
            return ended.phase === "refill" ? ended : null;
          })()
        : null;
  const plannedRefillOptions = plannedRefillState
    ? refillActions(plannedRefillState)
    : [];
  const canCompletePendingMove =
    pendingActions.length > 0 &&
    (!plannedRefillState ||
      (plannedRefillOptions.length > 0 && Boolean(plannedRefill)));

  const comparePlacement = (left: PlaceCardAction, right: PlaceCardAction) => {
    const leftKey = placementSortKey(pending, left);
    const rightKey = placementSortKey(pending, right);
    for (let index = 0; index < Math.max(leftKey.length, rightKey.length); index += 1) {
      const difference = (leftKey[index] ?? 0) - (rightKey[index] ?? 0);
      if (difference) return difference;
    }
    return 0;
  };

  const commitPlacement = (action: PlaceCardAction) => {
    const nextPendingState = applyKnownLegalAction(pending, action);
    const nextPendingActions = [...pendingActions, action];
    setPendingState(nextPendingState);
    setPendingActions(nextPendingActions);
    setSelectedHandIndex(null);
    setFrameChoices([]);
    setSelectedFrameAction(null);
    setPlannedRefill(null);
    setComparison(null);
  };

  const choosePosition = (x: number, y: number) => {
    const choices = selectedActions.filter(
      (action) => action.position.x === x && action.position.y === y,
    );
    const bestChoice = [...choices].sort(comparePlacement)[0] ?? null;
    if (!bestChoice) return;
    if (!manualFrameSelection) {
      commitPlacement(bestChoice);
      return;
    }
    setFrameChoices(choices);
    setSelectedFrameAction(bestChoice);
  };

  const chooseFrameAnchor = (x: number, y: number) => {
    const action = frameChoices.find(
      (choice) => choice.frame.x + 2 === x && choice.frame.y + 2 === y,
    );
    if (action) setSelectedFrameAction(action);
  };

  const confirmFrame = () => {
    if (!selectedFrameAction) return;
    commitPlacement(selectedFrameAction);
  };

  const resetOwnMove = () => {
    setPendingState(null);
    setPendingActions([]);
    setSelectedHandIndex(null);
    setFrameChoices([]);
    setSelectedFrameAction(null);
    setPlannedRefill(null);
    setComparison(null);
    setPreplayOnly(null);
    setPreview("own");
  };

  const compare = async (
    actions = pendingActions,
    refill = plannedRefill,
  ) => {
    const ownCandidate = completeHumanCandidate(
      state,
      actions,
      history,
      refill,
    );
    if (!ownCandidate) return;
    setThinking(true);
    setMessage(`${activeModelIds.length}モデルで候補手を比較しています…`);
    try {
      const candidates = enumerateTurnCandidates(state, history);
      const models = await evaluateAllModels(
        candidates,
        ownCandidate,
        viewPlayerIndex,
        state,
        v2Tracking,
        history,
        activeModelIds,
      );
      if (!models.some((model) => model.status === "ok")) {
        throw new Error("すべてのモデルで分析に失敗しました");
      }
      setComparison({ models });
      const first = models.find((model) => model.status === "ok");
      setPreview(first ? `${first.spec.id}:own` : "own");
      const failures = models.filter((model) => model.status === "error").length;
      setMessage(
        failures
          ? `${failures}モデルは利用できませんでした。残りの結果を表示します。`
          : "",
      );
    } catch (error) {
      setMessage("AI分析を利用できません。この手は分析なしで確定できます。");
    } finally {
      setThinking(false);
    }
  };

  const commitCandidate = async (evaluation?: TurnEvaluation) => {
    const candidate =
      evaluation?.candidate ??
      completeHumanCandidate(state, pendingActions, history, plannedRefill);
    if (!candidate) return;
    if (isOnline && onlineSession && activeOnlineGame) {
      setThinking(true);
      try {
        const value = await submitOnlineTurn(
          onlineSession.id,
          activeOnlineGame.id,
          activeOnlineGame.revision,
          candidate.actions,
        );
        setOnlineLobby(value.lobby);
        setComparison(null);
        resetOwnMove();
      } catch (error) {
        setMessage(error instanceof Error ? error.message : String(error));
      } finally {
        setThinking(false);
      }
      return;
    }
    setV2Tracking(
      replayV2Actions(state, candidate.actions, v2Tracking).tracking,
    );
    setHistory(candidate.history);
    setState(candidate.state);
    setComparison(null);
  };

  const exportComparison = async () => {
    if (!comparison) return;
    let registry: { models?: Array<{ id: string }> } | null = null;
    try {
      const response = await fetch(
        `${import.meta.env.BASE_URL}models/registry.json`,
      );
      if (response.ok) registry = await response.json();
    } catch {
      // The rest of the audit data remains fully downloadable offline.
    }
    const serializeEvaluation = (
      evaluation: TurnEvaluation,
      includeResultState = false,
    ) => ({
      probability: evaluation.probability,
      playedCardsSignature: playedCardsSignature(
        state,
        evaluation.candidate.actions,
      ),
      refillDecision: candidateRefillDecision(evaluation.candidate.actions),
      candidateGroupSignature: candidateGroupSignature(
        state,
        evaluation.candidate.actions,
      ),
      actions: evaluation.candidate.actions,
      historyAfter: evaluation.candidate.history,
      // Keep the hand at the decision boundary separate from resultingState,
      // which may already contain randomly drawn refill cards.
      preRefillHand: handBeforeRefill(state, evaluation.candidate.actions),
      ...(includeResultState
        ? { resultingState: evaluation.candidate.state }
        : {}),
    });
    const exportedAt = new Date();
    downloadJson(
      `yellowstone-analysis-${exportedAt.toISOString().replace(/[:.]/g, "-")}.json`,
      {
        schemaVersion: 2,
        exportedAt: exportedAt.toISOString(),
        application: {
          name: "yellowstone-browser",
          version: "0.1.0",
        },
        runtime: {
          runtime: "onnxruntime-web",
          registry,
        },
        settings,
        turnStartState: state,
        recentHistory: history,
        v2Tracking,
        plannedRefill,
        modelResults: comparison.models.map((model) => ({
          modelId: model.spec.id,
          label: model.spec.label,
          scoreKind: model.spec.scoreKind,
          ...(model.spec.encoder.startsWith("privileged")
            ? {
                scoreMeaning:
                  model.spec.encoder === "privileged_safe_counts"
                    ? "preplay_before_probability_and_postplay_candidate_probability"
                    : "preplay_win_probability_before_action_and_refill",
                candidateMeaning: "legal_turn_plan_attached_for_comparison_only",
                preplayBeforeProbability: model.preplayBeforeProbability,
                preplayPostSampleCount: model.preplayPostSampleCount,
              }
            : {}),
          status: model.status,
          error: model.error,
          playerSelection: model.own
            ? serializeEvaluation(model.own, true)
            : null,
          aiTop3: model.top.map((value) =>
            serializeEvaluation(value, true),
          ),
          allAiCandidates: model.all.map((value) =>
            serializeEvaluation(value),
          ),
        })),
      },
    );
  };

  const humanRefills = isHumanTurn ? refillActions(state) : [];
  const selectedModel =
    PLAYABLE_MODEL_SPECS.find((spec) => spec.id === primaryPlayableModelId) ??
    PLAYABLE_MODEL_SPECS[0];

  return (
    <main className={`game-page${comparison ? " is-comparing-page" : ""}`}>
      <header className="game-header">
        <div>
          <p className="eyebrow">4 PLAYER GAME</p>
          <h1>Yellowstone park</h1>
        </div>
        <div className="header-actions">
          <span>
            {(isOnline ? activeOnlineGame?.cpuDifficulty : settings.difficulty) ===
            "expert"
              ? "強化NPC"
              : "通常NPC"}
          </span>
          <span>
            {settings.assistMode === "analysis"
              ? "AI分析"
              : settings.assistMode === "preplay"
                ? "Pre-play"
                : "分析なし"}
          </span>
          <span>{activeModelIds.length} AI models</span>
          <span>NPC: {selectedModel.label}</span>
          {isOnline && activeOnlineGame && (
            <span>
              online seat {viewPlayerIndex} rev {activeOnlineGame.revision}
            </span>
          )}
          <button type="button" className="text-button" onClick={() => setScreen("details")}>
            詳細
          </button>
          <button type="button" className="text-button" onClick={() => setScreen("home")}>
            メニュー
          </button>
        </div>
      </header>

      <section className="score-strip">
        {state.players.map((player, index) => (
          <article
            key={index}
            className={state.currentPlayerIndex === index ? "active-player" : ""}
          >
            <strong>
              {activeOnlineGame?.seats[index]?.name ??
                (index === viewPlayerIndex ? "あなた" : `NPC ${index}`)}
            </strong>
            <span>失点 {player.lossScore}</span>
            <span>手札 {player.hand.length}</span>
            <span>マイナス {player.negativeCards.length}</span>
            {isOnline && (
              <span className="last-turn">
                {turnSummaryText(activeOnlineGame?.lastTurns?.[index])}
              </span>
            )}
          </article>
        ))}
      </section>

      {message && <p className="notice">{message}</p>}

      {isHumanTurn && settings.assistMode !== "none" && preplayOnly && (
        <section className="comparison">
          <div className="comparison-heading">
            <h2>Pre-play win rate</h2>
            {preplayOnly.status === "loading" && <span>calculating...</span>}
            {preplayOnly.status === "ok" && (
              <strong className="preplay-summary">
                Before your play: {((preplayOnly.probability ?? 0) * 100).toFixed(1)}%
              </strong>
            )}
            {preplayOnly.status === "error" && (
              <span className="model-error">{preplayOnly.error}</span>
            )}
          </div>
        </section>
      )}

      {state.phase === "game_over" ? (
        <section className="game-over">
          <p className="eyebrow">GAME OVER</p>
          <h2>
            {state.winners.includes(viewPlayerIndex)
              ? "あなたの勝利です"
              : `NPC ${state.winners.join(", ")} の勝利です`}
          </h2>
          <button type="button" className="primary" onClick={startNew}>
            もう一度遊ぶ
          </button>
          <button
            type="button"
            onClick={() => {
              clearSavedGame();
              setState(null);
              setScreen("home");
            }}
          >
            終了
          </button>
        </section>
      ) : (
        <div className={`game-layout${comparison ? " is-comparing" : ""}`}>
          <section className="board-panel">
            <Board
              board={shownBoard}
              legalPositionKeys={
                comparison || frameChoices.length ? new Set() : legalPositionKeys
              }
              frameAnchorKeys={comparison ? new Set() : frameAnchorKeys}
              penaltyPositionKeys={penaltyPositionKeys}
              previewActions={shownPlacements}
              previewFrame={shownFrame}
              onPositionClick={choosePosition}
              onFrameAnchorClick={chooseFrameAnchor}
            />
          </section>

          <aside className="control-panel">
            {!isHumanTurn && (
              <div className="turn-status">
                <span className={thinking ? "spinner" : ""} />
                {isOnline && currentTurnName
                  ? `${currentTurnName}のターンです`
                  : "NPCのターンです"}
              </div>
            )}

            {!isHumanTurn && (
              <section>
                <div className="section-title">
                  <h2>あなたの手札</h2>
                  <span>{human.hand.length}枚</span>
                </div>
                <Hand
                  cards={human.hand}
                  selectedIndex={null}
                  disabled
                  onSelect={() => undefined}
                />
              </section>
            )}

            {isHumanTurn && humanRefills.length > 0 && (
              <section>
                <h2>手札を補充</h2>
                <p>補充方法を選んでください。</p>
                {humanRefills.map((action) => (
                  <button
                    type="button"
                    key={action.source}
                    onClick={async () => {
                      if (isOnline && onlineSession && activeOnlineGame) {
                        setThinking(true);
                        try {
                          const value = await submitOnlineTurn(
                            onlineSession.id,
                            activeOnlineGame.id,
                            activeOnlineGame.revision,
                            [action],
                          );
                          setOnlineLobby(value.lobby);
                        } catch (error) {
                          setMessage(
                            error instanceof Error ? error.message : String(error),
                          );
                        } finally {
                          setThinking(false);
                        }
                        return;
                      }
                      const applied = applyActionTrackingHistory(
                        state,
                        action,
                        history,
                      );
                      setV2Tracking(
                        observeV2Action(
                          v2Tracking,
                          state,
                          action,
                          applied.state,
                        ),
                      );
                      setState(applied.state);
                      setHistory(applied.history);
                    }}
                  >
                    {action.source === "deck"
                      ? "山札から補充"
                      : action.source === "negative_cards"
                        ? "マイナスカードから補充"
                        : "補充しない"}
                  </button>
                ))}
              </section>
            )}

            {isHumanTurn && !humanRefills.length && (
              <>
                <section>
                  <div className="section-title">
                    <h2>あなたの手</h2>
                    <span>{pendingActions.length}/2枚</span>
                  </div>
                  <div className="frame-mode">
                    <span>Frame選択</span>
                    <button
                      type="button"
                      className={manualFrameSelection ? "selected" : ""}
                      aria-pressed={manualFrameSelection}
                      onClick={() => {
                        setManualFrameSelection((value) => {
                          const next = !value;
                          if (!next) {
                            setFrameChoices([]);
                            setSelectedFrameAction(null);
                          }
                          return next;
                        });
                      }}
                    >
                      {manualFrameSelection ? "ON" : "OFF"}
                    </button>
                  </div>
                  <Hand
                    cards={shownHand}
                    selectedIndex={selectedHandIndex}
                    disabled={Boolean(comparison) || thinking || pending.phase === "refill"}
                    onSelect={(index) => {
                      setSelectedHandIndex(index);
                      setFrameChoices([]);
                      setSelectedFrameAction(null);
                    }}
                  />
                  {selectedHandIndex !== null && !frameChoices.length && (
                    <p className="hint">光っている配置先を選んでください。</p>
                  )}
                  {frameChoices.length > 0 && (
                    <div className="frame-picker">
                      <div>
                        <strong>残す3×3枠</strong>
                        <p>
                          最少失点の枠を仮選択しています。盤面で黄色く光るマスを押すと、
                          そのマスを左上とした枠へ変更できます。
                          枠外の暗いカード{penaltyCardCount}枚は失点になります。
                        </p>
                      </div>
                      <button
                        type="button"
                        className="primary frame-confirm"
                        onClick={confirmFrame}
                        disabled={!selectedFrameAction}
                      >
                        OK
                      </button>
                    </div>
                  )}
                </section>

                {plannedRefillOptions.length > 0 &&
                  !comparison && (
                    <section className="planned-refill">
                      <h2>補充方法を選択</h2>
                      <p>
                        補充方法を決めた後、その選択を含めてAIが勝率を比較します。
                      </p>
                      <div>
                        {plannedRefillOptions.map((action) => (
                          <button
                            type="button"
                            key={action.source}
                            className={
                              plannedRefill?.source === action.source
                                ? "selected"
                                : ""
                            }
                            disabled={thinking}
                            onClick={() => {
                              setPlannedRefill(action);
                              if (settings.assistMode === "analysis") {
                                void compare(pendingActions, action);
                              }
                            }}
                          >
                            {action.source === "deck"
                              ? "山札から補充"
                              : action.source === "negative_cards"
                                ? "マイナスカードから補充"
                                : "補充しない"}
                          </button>
                        ))}
                      </div>
                    </section>
                  )}

                {comparison && (
                  <section className="comparison">
                    <div className="comparison-heading">
                      <h2>{comparison.models.length}モデル比較</h2>
                      <span>候補を選ぶと盤面にプレビューします</span>
                      {(() => {
                        const preplay = comparison.models.find(
                          (model) => model.spec.id === "preplay-v1-current",
                        )?.own;
                        return preplay ? (
                          <strong className="preplay-summary">
                            Pre-play（補充前）: {(preplay.probability * 100).toFixed(1)}%
                          </strong>
                        ) : null;
                      })()}
                      {preplayModels
                        .filter((model) => model.spec.id !== "preplay-v1-current")
                        .map((model) => {
                          const selected = selectedPreplayEvaluation(model);
                          return model.status === "ok" && selected ? (
                            <strong className="preplay-summary" key={model.spec.id}>
                              {model.spec.label}: before{" "}
                              {(
                                (model.preplayBeforeProbability ?? model.own?.probability ?? 0) *
                                100
                              ).toFixed(1)}
                              % / after {(selected.probability * 100).toFixed(1)}% /{" "}
                              {describePlan(state, selected.candidate.actions)}
                            </strong>
                          ) : (
                            <strong className="preplay-summary" key={model.spec.id}>
                              {model.spec.label}: error
                            </strong>
                          );
                        })}
                    </div>
                    <div className="comparison-column-headings" aria-hidden="true">
                      <span>モデル</span>
                      <span>あなた</span>
                      <span>AI 1位</span>
                      <span>AI 2位</span>
                      <span>AI 3位</span>
                    </div>
                    <div className="model-comparisons">
                      {visibleModels?.map((model) => (
                        <article className="model-comparison" key={model.spec.id}>
                          <header className="model-identity">
                            <h3>{model.spec.label}</h3>
                            {model.spec.encoder === "privileged" && (
                              <small className="model-note model-note-privileged">
                                Pre-play: 補充前の状態から推定した勝率。候補手は比較表示用で、手自体は入力していません。
                              </small>
                            )}
                            <span>
                              {model.spec.scoreKind === "delta"
                                ? "改善度（勝率ではありません）"
                                : "推定勝率"}
                            </span>
                            {(model.spec.encoder === "v1" ||
                              model.spec.encoder === "privileged" ||
                              model.spec.scoreKind === "delta") && (
                              <small className="model-note">
                                補充方法は評価対象外
                              </small>
                            )}
                          </header>
                          {model.status === "error" || !model.own ? (
                            <p className="model-error">{model.error}</p>
                          ) : (
                            <>
                              <div className="comparison-cards">
                                {[
                                  {
                                    key: `${model.spec.id}:own` as Preview,
                                    label: "あなたの手",
                                    value: model.own,
                                  },
                                  ...model.top.map((value, index) => ({
                                    key: `${model.spec.id}:ai-${index}` as Preview,
                                    label: `AI ${index + 1}位`,
                                    value,
                                  })),
                                ].map(({ key, label, value }) => {
                                  const difference =
                                    (value.probability -
                                      model.own!.probability) *
                                    100;
                                  const sameCards =
                                    !key.endsWith(":own") &&
                                    playedCardsSignature(
                                      state,
                                      value.candidate.actions,
                                    ) ===
                                      playedCardsSignature(
                                        state,
                                        model.own!.candidate.actions,
                                      );
                                  const sameRefill =
                                    candidateRefillDecision(
                                      value.candidate.actions,
                                    ) ===
                                    candidateRefillDecision(
                                      model.own!.candidate.actions,
                                    );
                                  const planDescription = describePlan(
                                    state,
                                    value.candidate.actions,
                                  );
                                  const beforePlayer = state.players[viewPlayerIndex];
                                  const afterPlayer =
                                    value.candidate.state.players[viewPlayerIndex];
                                  const bonus = Math.max(
                                    0,
                                    beforePlayer.lossScore - afterPlayer.lossScore,
                                  );
                                  const penalty = Math.max(
                                    0,
                                    afterPlayer.negativeCards.length -
                                      beforePlayer.negativeCards.length,
                                  );
                                  return (
                                    <button
                                      type="button"
                                      key={key}
                                      className={preview === key ? "selected" : ""}
                                      onClick={() => setPreview(key)}
                                    >
                                      <span>{label}</span>
                                      <strong>
                                        {formattedScore(
                                          value.probability,
                                          model.spec.scoreKind,
                                        )}
                                      </strong>
                                      <small title={planDescription}>
                                        {planDescription}
                                      </small>
                                      {(bonus !== 0 || penalty !== 0) && (
                                        <span className="candidate-effects">
                                          {bonus !== 0 && (
                                            <b className="candidate-bonus">+{bonus}</b>
                                          )}
                                          {penalty !== 0 && (
                                            <b className="candidate-penalty">-{penalty}</b>
                                          )}
                                        </span>
                                      )}
                                      {sameCards && (
                                        <b className="same-cards">
                                          {sameRefill
                                            ? "同じカード"
                                            : "同じカード・補充違い"}
                                        </b>
                                      )}
                                      {!key.endsWith(":own") && (
                                        <em>
                                          {difference > 0 ? "+" : ""}
                                          {difference.toFixed(1)}
                                          {model.spec.scoreKind === "delta"
                                            ? "pt"
                                            : "ポイント"}
                                        </em>
                                      )}
                                    </button>
                                  );
                                })}
                              </div>
                            </>
                          )}
                        </article>
                      ))}
                    </div>
                    <button
                      type="button"
                      className="download-analysis"
                      onClick={() => void exportComparison()}
                    >
                      検証データをダウンロード
                    </button>
                  </section>
                )}

                <div className="control-actions">
                  {pendingActions.length > 0 &&
                    !comparison &&
                    !frameChoices.length &&
                    canCompletePendingMove && (
                    <>
                      {pendingActions.length === 1 ? (
                        <button
                          type="button"
                          className="primary"
                          onClick={() =>
                            settings.assistMode === "analysis"
                              ? void compare()
                              : commitCandidate()
                          }
                          disabled={thinking}
                        >
                          1枚プレイで終える
                        </button>
                      ) : settings.assistMode === "none" ? (
                        <button
                          type="button"
                          className="primary"
                          onClick={() => commitCandidate()}
                        >
                          この手でプレイ
                        </button>
                      ) : null}
                    </>
                  )}
                  {comparison && (
                    <button
                      type="button"
                      className="primary"
                      onClick={() => commitCandidate(shownEvaluation)}
                    >
                      表示中の手でプレイ
                    </button>
                  )}
                  {pendingActions.length > 0 && (
                    <button type="button" onClick={resetOwnMove}>
                      自分の手を選び直す
                    </button>
                  )}
                  {pendingActions.length === 1 &&
                    !comparison &&
                    !frameChoices.length && (
                      <p className="continue-hint">
                        2枚目をプレイする場合は、続けて手札からカードを選んでください。
                      </p>
                    )}
                </div>
              </>
            )}
          </aside>
        </div>
      )}
      <footer>
        山札 {state.deck.length}枚 ・ 決算 {state.settlementCount}回
      </footer>
    </main>
  );
}
