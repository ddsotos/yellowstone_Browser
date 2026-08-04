import { useEffect, useMemo, useRef, useState } from "react";
import {
  AiTimeoutError,
  CURRENT_MODEL_ID,
  evaluateAllModels,
  ModelAnalysis,
  ModelId,
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
  clearSavedGame,
  Difficulty,
  loadGame,
  saveGame,
  Settings,
} from "./storage";

type Screen = "home" | "game" | "details";
type Preview = "own" | `${string}:own` | `${string}:ai-${number}`;

const MODEL_IDS = PLAYABLE_MODEL_SPECS.map((spec) => spec.id) as ModelId[];
const MODEL_ID_SET = new Set<ModelId>(MODEL_IDS);

interface Comparison {
  models: ModelAnalysis[];
}

const defaultSettings: Settings = {
  difficulty: "standard",
  assistMode: "none",
  npcModelId: CURRENT_MODEL_ID,
  modelIds: MODEL_IDS,
};

const sanitizeModelIds = (modelIds?: readonly ModelId[]): ModelId[] => {
  const selected = (modelIds ?? [])
    .filter((id): id is ModelId => MODEL_ID_SET.has(id))
    .slice(0, 3);
  return selected.length ? selected : MODEL_IDS;
};

const sanitizePlayableModelId = (modelId?: ModelId): ModelId =>
  modelId && MODEL_ID_SET.has(modelId) ? modelId : CURRENT_MODEL_ID;

const sanitizeSettings = (settings?: Partial<Settings>): Settings => ({
  ...defaultSettings,
  ...settings,
  assistMode: settings?.assistMode === "analysis" ? "analysis" : "none",
  npcModelId: sanitizePlayableModelId(settings?.npcModelId ?? settings?.modelId),
  modelIds: sanitizeModelIds(settings?.modelIds ?? (settings?.modelId ? [settings.modelId] : [])),
});

const cardLabel = (action: PlaceCardAction, before: GameState): string => {
  const card = before.players[before.currentPlayerIndex].hand[action.handIndex];
  const color = { red: "R", blue: "B", green: "G", yellow: "Y" }[card.color];
  return `${color}${card.rankIndex + 1}`;
};

const actionLabel = (start: GameState, actions: Action[]): string => {
  let state = start;
  const labels: string[] = [];
  for (const action of actions) {
    if (action.type === "place") labels.push(cardLabel(action, state));
    if (action.type === "end_turn") labels.push("end");
    if (action.type === "refill") labels.push(`refill:${action.source}`);
    state = applyKnownLegalAction(state, action);
  }
  return labels.join(" -> ");
};

const formattedScore = (value: number): string =>
  `${Math.round(value * 1000) / 10}%`;

const handBeforeRefill = (start: GameState, actions: Action[]) => {
  const hand = [...start.players[start.currentPlayerIndex].hand];
  for (const action of actions) {
    if (action.type === "place") hand.splice(action.handIndex, 1);
  }
  return hand;
};

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
  const savedAtStart = useMemo(loadGame, []);
  const initialSettings = useMemo(
    () => sanitizeSettings(savedAtStart?.settings),
    [savedAtStart],
  );
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
  const [plannedRefill, setPlannedRefill] = useState<RefillAction | null>(null);
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const [preview, setPreview] = useState<Preview>("own");
  const [message, setMessage] = useState("");
  const [thinking, setThinking] = useState(false);
  const npcRunning = useRef(false);
  const activeModelIds = sanitizeModelIds(settings.modelIds);
  const selectedModel =
    PLAYABLE_MODEL_SPECS.find((spec) => spec.id === settings.npcModelId) ??
    PLAYABLE_MODEL_SPECS.at(-1)!;

  useEffect(() => {
    if (state) saveGame(state, history, settings, v2Tracking);
  }, [state, history, settings, v2Tracking]);

  useEffect(() => {
    if (
      screen === "game" &&
      (settings.assistMode === "analysis" || settings.difficulty === "expert")
    ) {
      warmAi(settings.npcModelId);
    }
  }, [screen, settings.assistMode, settings.difficulty]);

  useEffect(() => {
    if (
      state?.phase === "play" &&
      state.currentPlayerIndex === 0 &&
      state.cardsPlayedThisTurn === 0
    ) {
      setPendingState(state);
      setPendingActions([]);
      setSelectedHandIndex(null);
      setPlannedRefill(null);
      setComparison(null);
      setPreview("own");
    }
  }, [state]);

  useEffect(() => {
    if (
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
      setMessage(`NPC ${state.currentPlayerIndex} is thinking...`);
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
            settings.npcModelId,
          );
          nextV2Tracking = replayV2Actions(
            nextState,
            best.candidate.actions,
            nextV2Tracking,
          ).tracking;
          nextState = best.candidate.state;
          nextHistory = best.candidate.history;
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
        setMessage(
          error instanceof AiTimeoutError
            ? "Expert model timed out; heuristic move was used."
            : "Expert model failed; heuristic move was used.",
        );
      } finally {
        setHistory(nextHistory);
        setV2Tracking(nextV2Tracking);
        setState(nextState);
        setThinking(false);
        npcRunning.current = false;
      }
    };
    void run();
  }, [state, history, settings.difficulty, v2Tracking]);

  const startNew = () => {
    if (state && !window.confirm("Start a new game and replace the saved game?")) {
      return;
    }
    const next = createInitialState(4);
    setState(next);
    setHistory([]);
    setV2Tracking(createV2Tracking(4));
    setSettings((value) => sanitizeSettings(value));
    setScreen("game");
    setMessage("");
  };

  if (screen === "details") return <Details onBack={() => setScreen("game")} />;

  if (screen === "home") {
    return (
      <main className="home">
        <p className="eyebrow">LOCAL DEVELOPMENT PREVIEW</p>
        <h1>Yellowstone park</h1>
        <p className="lead">
          Play a local four-player Yellowstone game with the current bundled AI
          model.
        </p>
        <div className="setup-card">
          <fieldset>
            <legend>NPC difficulty</legend>
            {(["standard", "expert"] as const).map((difficulty) => (
              <label key={difficulty}>
                <input
                  type="radio"
                  checked={settings.difficulty === difficulty}
                  onChange={() =>
                    setSettings((value) => ({ ...value, difficulty }))
                  }
                />
                {difficulty}
              </label>
            ))}
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
                      setSettings((value) =>
                        sanitizeSettings({ ...value, npcModelId: spec.id }),
                      )
                    }
                  />
                  <span>{spec.label}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset>
            <legend>Move analysis</legend>
            {(["none", "analysis"] as const).map((assistMode) => (
              <label key={assistMode}>
                <input
                  type="radio"
                  checked={settings.assistMode === assistMode}
                  onChange={() =>
                    setSettings((value) => ({ ...value, assistMode }))
                  }
                />
                {assistMode}
              </label>
            ))}
          </fieldset>
          <fieldset className="model-picker">
            <legend>Analysis models ({activeModelIds.length}/3)</legend>
            <div className="model-options">
              {PLAYABLE_MODEL_SPECS.map((spec) => (
                <label key={spec.id}>
                  <input
                    type="checkbox"
                    checked={activeModelIds.includes(spec.id)}
                    disabled={
                      !activeModelIds.includes(spec.id) &&
                      activeModelIds.length >= 3
                    }
                    onChange={(event) =>
                      setSettings((value) => {
                        const current = sanitizeModelIds(value.modelIds);
                        const next = event.target.checked
                          ? [...current, spec.id].slice(0, 3)
                          : current.filter((id) => id !== spec.id);
                        return sanitizeSettings({
                          ...value,
                          modelIds: next.length ? next : current,
                        });
                      })
                    }
                  />
                  <span>{spec.label}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <button type="button" className="primary" onClick={startNew}>
            New game
          </button>
          {savedAtStart && state && (
            <button type="button" onClick={() => setScreen("game")}>
              Continue
            </button>
          )}
          <button type="button" className="text-button" onClick={() => setScreen("details")}>
            Details
          </button>
        </div>
      </main>
    );
  }

  if (!state) return null;
  const isHumanTurn = state.currentPlayerIndex === 0 && state.phase !== "game_over";
  const pending = pendingState ?? state;
  const human = state.players[0];
  const humanRefills = isHumanTurn ? refillActions(state) : [];
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
  const shownModel = comparison?.models.find((model) => model.status === "ok");
  const [previewModelId, previewChoice] =
    preview === "own" ? ["", "own"] : preview.split(":");
  const previewModel =
    comparison?.models.find((model) => model.spec.id === previewModelId) ??
    shownModel;
  const shownEvaluation =
    previewChoice === "own"
      ? previewModel?.own
      : previewModel?.top[Number(previewChoice.slice(3))];
  const shownBoard = shownEvaluation?.candidate.state.board ?? pending.board;
  const shownHand = shownEvaluation
    ? handBeforeRefill(state, shownEvaluation.candidate.actions)
    : pending.players[0].hand;
  const shownPlacements = (
    shownEvaluation?.candidate.actions ?? pendingActions
  ).filter((action): action is PlaceCardAction => action.type === "place");
  const plannedRefillState =
    pendingActions.length > 0 && !comparison
      ? pending.phase === "refill"
        ? pending
        : legalActions(pending).some((action) => action.type === "end_turn")
          ? applyKnownLegalAction(pending, { type: "end_turn" })
          : null
      : null;
  const plannedRefillOptions = plannedRefillState
    ? refillActions(plannedRefillState)
    : [];
  const canCommitPending =
    pendingActions.length > 0 &&
    (!plannedRefillOptions.length || Boolean(plannedRefill));

  const choosePosition = (x: number, y: number) => {
    const choice = [...selectedActions]
      .filter((action) => action.position.x === x && action.position.y === y)
      .sort((left, right) => {
        const leftKey = placementSortKey(pending, left);
        const rightKey = placementSortKey(pending, right);
        for (let index = 0; index < Math.max(leftKey.length, rightKey.length); index += 1) {
          const difference = (leftKey[index] ?? 0) - (rightKey[index] ?? 0);
          if (difference) return difference;
        }
        return 0;
      })[0];
    if (!choice) return;
    const nextPending = applyKnownLegalAction(pending, choice);
    setPendingState(nextPending);
    setPendingActions((value) => [...value, choice]);
    setSelectedHandIndex(null);
    setPlannedRefill(null);
    setComparison(null);
  };

  const commitCandidate = (evaluation?: TurnEvaluation) => {
    const candidate =
      evaluation?.candidate ??
      completeHumanCandidate(state, pendingActions, history, plannedRefill);
    if (!candidate) return;
    setV2Tracking(replayV2Actions(state, candidate.actions, v2Tracking).tracking);
    setHistory(candidate.history);
    setState(candidate.state);
    setPendingState(null);
    setPendingActions([]);
    setPlannedRefill(null);
    setComparison(null);
    setPreview("own");
  };

  const compare = async () => {
    const ownCandidate = completeHumanCandidate(
      state,
      pendingActions,
      history,
      plannedRefill,
    );
    if (!ownCandidate) return;
    setThinking(true);
    setMessage("Analyzing legal turns...");
    try {
      const models = await evaluateAllModels(
        enumerateTurnCandidates(state, history),
        ownCandidate,
        0,
        state,
        v2Tracking,
        history,
        activeModelIds,
      );
      if (!models.some((model) => model.status === "ok")) {
        throw new Error("model evaluation failed");
      }
      setComparison({ models });
      const first = models.find((model) => model.status === "ok");
      setPreview(first ? `${first.spec.id}:own` : "own");
      setMessage("");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setThinking(false);
    }
  };

  const exportComparison = async () => {
    if (!comparison) return;
    const exportedAt = new Date();
    downloadJson(
      `yellowstone-analysis-${exportedAt.toISOString().replace(/[:.]/g, "-")}.json`,
      {
        schemaVersion: 2,
        exportedAt: exportedAt.toISOString(),
        settings: sanitizeSettings(settings),
        turnStartState: state,
        recentHistory: history,
        v2Tracking,
        plannedRefill,
        modelResults: comparison.models.map((model) => ({
          modelId: model.spec.id,
          label: model.spec.label,
          scoreKind: model.spec.scoreKind,
          status: model.status,
          error: model.error,
          playerSelection: model.own
            ? {
                probability: model.own.probability,
                actions: model.own.candidate.actions,
                playedCardsSignature: playedCardsSignature(
                  state,
                  model.own.candidate.actions,
                ),
                refillDecision: candidateRefillDecision(
                  model.own.candidate.actions,
                ),
              }
            : null,
          aiTop3: model.top.map((value) => ({
            probability: value.probability,
            actions: value.candidate.actions,
            candidateGroupSignature: candidateGroupSignature(
              state,
              value.candidate.actions,
            ),
          })),
        })),
      },
    );
  };

  return (
    <main className={`game-page${comparison ? " is-comparing-page" : ""}`}>
      <header className="game-header">
        <div>
          <p className="eyebrow">4 PLAYER GAME</p>
          <h1>Yellowstone park</h1>
        </div>
        <div className="header-actions">
          <span>{settings.difficulty}</span>
          <span>{settings.assistMode === "analysis" ? "AI analysis" : "No analysis"}</span>
          <span>NPC: {selectedModel.label}</span>
          <button type="button" className="text-button" onClick={() => setScreen("details")}>
            Details
          </button>
          <button type="button" className="text-button" onClick={() => setScreen("home")}>
            Menu
          </button>
        </div>
      </header>

      <section className="score-strip">
        {state.players.map((player, index) => (
          <article
            key={index}
            className={state.currentPlayerIndex === index ? "active-player" : ""}
          >
            <strong>{index === 0 ? "You" : `NPC ${index}`}</strong>
            <span>loss {player.lossScore}</span>
            <span>hand {player.hand.length}</span>
            <span>negative {player.negativeCards.length}</span>
          </article>
        ))}
      </section>

      {message && <p className="notice">{message}</p>}

      {state.phase === "game_over" ? (
        <section className="game-over">
          <p className="eyebrow">GAME OVER</p>
          <h2>{state.winners.includes(0) ? "You win" : `NPC ${state.winners.join(", ")} wins`}</h2>
          <button type="button" className="primary" onClick={startNew}>
            Play again
          </button>
          <button
            type="button"
            onClick={() => {
              clearSavedGame();
              setState(null);
              setScreen("home");
            }}
          >
            Clear saved game
          </button>
        </section>
      ) : (
        <div className={`game-layout${comparison ? " is-comparing" : ""}`}>
          <section className="board-panel">
            <Board
              board={shownBoard}
              legalPositionKeys={comparison ? new Set() : legalPositionKeys}
              previewActions={shownPlacements}
              onPositionClick={choosePosition}
            />
          </section>

          <aside className="control-panel">
            {!isHumanTurn && (
              <div className="turn-status">
                <span className={thinking ? "spinner" : ""} />
                NPC turn
              </div>
            )}

            {isHumanTurn && humanRefills.length > 0 && (
              <section>
                <h2>Refill hand</h2>
                {humanRefills.map((action) => (
                  <button
                    type="button"
                    key={action.source}
                    onClick={() => {
                      const applied = applyActionTrackingHistory(
                        state,
                        action,
                        history,
                      );
                      setV2Tracking(
                        observeV2Action(v2Tracking, state, action, applied.state),
                      );
                      setState(applied.state);
                      setHistory(applied.history);
                    }}
                  >
                    {action.source}
                  </button>
                ))}
              </section>
            )}

            {isHumanTurn && !humanRefills.length && (
              <>
                <section>
                  <div className="section-title">
                    <h2>Your hand</h2>
                    <span>{pendingActions.length}/2 cards</span>
                  </div>
                  <Hand
                    cards={shownHand}
                    selectedIndex={selectedHandIndex}
                    disabled={Boolean(comparison) || thinking}
                    onSelect={setSelectedHandIndex}
                  />
                </section>

                {selectedHandIndex !== null && (
                  <p className="hint">Select a highlighted board position.</p>
                )}

                {plannedRefillOptions.length > 0 && (
                  <section className="planned-refill">
                    <h2>Refill after move</h2>
                    {plannedRefillOptions.map((action) => (
                      <button
                        type="button"
                        key={action.source}
                        className={plannedRefill?.source === action.source ? "selected" : ""}
                        onClick={() => setPlannedRefill(action)}
                      >
                        {action.source}
                      </button>
                    ))}
                  </section>
                )}

                {comparison && (
                  <section className="comparison">
                    <div className="comparison-heading">
                      <h2>AI analysis</h2>
                      <button type="button" onClick={() => void exportComparison()}>
                        Download JSON
                      </button>
                    </div>
                    <div className="model-comparisons">
                      {comparison.models.map((model) => (
                        <article className="model-comparison" key={model.spec.id}>
                          <header className="model-identity">
                            <h3>{model.spec.label}</h3>
                            <span>estimated win rate</span>
                          </header>
                          {model.status === "error" || !model.own ? (
                            <p className="model-error">{model.error}</p>
                          ) : (
                            <div className="comparison-cards">
                              {[
                                {
                                  key: `${model.spec.id}:own` as Preview,
                                  label: "your move",
                                  value: model.own,
                                },
                                ...model.top.map((value, index) => ({
                                  key: `${model.spec.id}:ai-${index}` as Preview,
                                  label: `AI ${index + 1}`,
                                  value,
                                })),
                              ].map(({ key, label, value }) => (
                                <button
                                  type="button"
                                  key={key}
                                  className={preview === key ? "selected" : ""}
                                  onClick={() => setPreview(key)}
                                >
                                  <span>{label}</span>
                                  <strong>{formattedScore(value.probability)}</strong>
                                  <small>{actionLabel(state, value.candidate.actions)}</small>
                                </button>
                              ))}
                            </div>
                          )}
                        </article>
                      ))}
                    </div>
                  </section>
                )}

                <div className="actions-row">
                  {settings.assistMode === "analysis" && !comparison && (
                    <button
                      type="button"
                      onClick={() => void compare()}
                      disabled={!canCommitPending || thinking}
                    >
                      Analyze
                    </button>
                  )}
                  {comparison && shownEvaluation && (
                    <button
                      type="button"
                      className="primary"
                      onClick={() => commitCandidate(shownEvaluation)}
                    >
                      Play previewed move
                    </button>
                  )}
                  {!comparison && (
                    <button
                      type="button"
                      className="primary"
                      onClick={() => commitCandidate()}
                      disabled={!canCommitPending || thinking}
                    >
                      Confirm move
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      setPendingState(state);
                      setPendingActions([]);
                      setSelectedHandIndex(null);
                      setPlannedRefill(null);
                      setComparison(null);
                      setPreview("own");
                    }}
                  >
                    Reset turn
                  </button>
                </div>
              </>
            )}
          </aside>
        </div>
      )}
    </main>
  );
}
