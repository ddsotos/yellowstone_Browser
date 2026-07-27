import { useEffect, useMemo, useRef, useState } from "react";
import {
  AiTimeoutError,
  evaluateCandidates,
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
  topDistinctCandidateEvaluations,
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

type Screen = "home" | "game" | "details";
type Preview = "own" | `ai-${number}`;

interface Comparison {
  own: TurnEvaluation;
  top: TurnEvaluation[];
  all: TurnEvaluation[];
}

const defaultSettings: Settings = {
  difficulty: "standard",
  assistMode: "none",
};

const cardName = (action: PlaceCardAction, before: GameState): string => {
  const card = before.players[before.currentPlayerIndex].hand[action.handIndex];
  const colors = { red: "赤", blue: "青", green: "緑", yellow: "黄" };
  return `${colors[card.color]}${card.rankIndex + 1}`;
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
  const [screen, setScreen] = useState<Screen>("home");
  const [settings, setSettings] = useState<Settings>(
    savedAtStart?.settings ?? defaultSettings,
  );
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
  const [plannedRefill, setPlannedRefill] = useState<RefillAction | null>(null);
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const [preview, setPreview] = useState<Preview>("own");
  const [message, setMessage] = useState("");
  const [thinking, setThinking] = useState(false);
  const npcRunning = useRef(false);

  useEffect(() => {
    if (state) saveGame(state, history, settings, v2Tracking);
  }, [state, history, settings, v2Tracking]);

  useEffect(() => {
    if (
      screen === "game" &&
      (settings.assistMode === "analysis" ||
        settings.difficulty === "expert")
    ) {
      warmAi();
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
      setFrameChoices([]);
      setSelectedFrameAction(null);
      setPlannedRefill(null);
      setComparison(null);
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
  }, [state, history, settings.difficulty, v2Tracking]);

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

  if (screen === "details") {
    return <Details onBack={() => setScreen(state ? "game" : "home")} />;
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
  const human = state.players[0];
  const isHumanTurn = state.currentPlayerIndex === 0 && state.phase !== "game_over";
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
  const shownEvaluation =
    preview === "own"
      ? comparison?.own
      : comparison?.top[Number(preview.slice(3))];
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
    ? refillActions(plannedRefillState).filter(
        (action) =>
          pendingActions.length !== 2 || action.source !== "none",
      )
    : [];
  const canCompletePendingMove =
    pendingActions.length > 0 &&
    (!plannedRefillState ||
      (plannedRefillOptions.length > 0 && Boolean(plannedRefill)));

  const choosePosition = (x: number, y: number) => {
    const choices = selectedActions.filter(
      (action) => action.position.x === x && action.position.y === y,
    );
    setFrameChoices(choices);
    setSelectedFrameAction(
      [...choices].sort(
        (left, right) =>
          placementSortKey(pending, left)[0] -
          placementSortKey(pending, right)[0],
      )[0] ?? null,
    );
  };

  const chooseFrameAnchor = (x: number, y: number) => {
    const action = frameChoices.find(
      (choice) => choice.frame.x + 2 === x && choice.frame.y + 2 === y,
    );
    if (action) setSelectedFrameAction(action);
  };

  const confirmFrame = () => {
    if (!selectedFrameAction) return;
    const nextPendingState = applyKnownLegalAction(pending, selectedFrameAction);
    const nextPendingActions = [...pendingActions, selectedFrameAction];
    setPendingState(nextPendingState);
    setPendingActions(nextPendingActions);
    setSelectedHandIndex(null);
    setFrameChoices([]);
    setSelectedFrameAction(null);
    setComparison(null);
  };

  const resetOwnMove = () => {
    setPendingState(state);
    setPendingActions([]);
    setSelectedHandIndex(null);
    setFrameChoices([]);
    setSelectedFrameAction(null);
    setPlannedRefill(null);
    setComparison(null);
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
    setMessage("候補手を比較しています…");
    try {
      const candidates = enumerateTurnCandidates(state, history);
      const evaluations = await evaluateCandidates(
        [...candidates, ownCandidate],
        0,
        state,
        v2Tracking,
      );
      const own = evaluations.at(-1);
      if (!own) throw new Error("自分の手を評価できません");
      const all = evaluations.slice(0, -1);
      const top = topDistinctCandidateEvaluations(state, all, 3);
      setComparison({ own, top, all });
      setPreview("own");
      setMessage("");
    } catch (error) {
      setMessage(
        error instanceof AiTimeoutError
          ? "AI分析が10秒を超えました。この手は分析なしで確定できます。"
          : "AI分析を利用できません。この手は分析なしで確定できます。",
      );
    } finally {
      setThinking(false);
    }
  };

  const commitCandidate = (evaluation?: TurnEvaluation) => {
    const candidate =
      evaluation?.candidate ??
      completeHumanCandidate(state, pendingActions, history, plannedRefill);
    if (!candidate) return;
    setV2Tracking(
      replayV2Actions(state, candidate.actions, v2Tracking).tracking,
    );
    setHistory(candidate.history);
    setState(candidate.state);
    setComparison(null);
  };

  const exportComparison = async () => {
    if (!comparison) return;
    let modelMetadata: unknown = null;
    try {
      const response = await fetch(
        `${import.meta.env.BASE_URL}models/win_value_v2.json`,
      );
      if (response.ok) modelMetadata = await response.json();
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
      ...(includeResultState
        ? { resultingState: evaluation.candidate.state }
        : {}),
    });
    const exportedAt = new Date();
    downloadJson(
      `yellowstone-analysis-${exportedAt.toISOString().replace(/[:.]/g, "-")}.json`,
      {
        schemaVersion: 1,
        exportedAt: exportedAt.toISOString(),
        application: {
          name: "yellowstone-browser",
          version: "0.1.0",
        },
        model: {
          runtime: "onnxruntime-web",
          modelPath: "models/win_value_v2.onnx",
          metadata: modelMetadata,
        },
        settings,
        turnStartState: state,
        recentHistory: history,
        v2Tracking,
        playerSelection: {
          plannedRefill,
          evaluation: serializeEvaluation(comparison.own, true),
        },
        aiTop3: comparison.top.map((value) =>
          serializeEvaluation(value, true),
        ),
        allAiCandidates: comparison.all.map((value) =>
          serializeEvaluation(value),
        ),
      },
    );
  };

  const humanRefills = isHumanTurn ? refillActions(state) : [];

  return (
    <main className="game-page">
      <header className="game-header">
        <div>
          <p className="eyebrow">4 PLAYER GAME</p>
          <h1>Yellowstone park</h1>
        </div>
        <div className="header-actions">
          <span>{settings.difficulty === "expert" ? "強化NPC" : "通常NPC"}</span>
          <span>{settings.assistMode === "analysis" ? "AI分析" : "分析なし"}</span>
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
            <strong>{index === 0 ? "あなた" : `NPC ${index}`}</strong>
            <span>失点 {player.lossScore}</span>
            <span>手札 {player.hand.length}</span>
            <span>マイナス {player.negativeCards.length}</span>
          </article>
        ))}
      </section>

      {message && <p className="notice">{message}</p>}

      {state.phase === "game_over" ? (
        <section className="game-over">
          <p className="eyebrow">GAME OVER</p>
          <h2>
            {state.winners.includes(0)
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
        <div className="game-layout">
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
                NPCのターンです
              </div>
            )}

            {isHumanTurn && humanRefills.length > 0 && (
              <section>
                <h2>手札を補充</h2>
                <p>補充方法を選んでください。</p>
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
                  <Hand
                    cards={pending.players[0].hand}
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
                    <h2>勝率を比較</h2>
                    <div className="comparison-cards">
                      {[
                        {
                          key: "own" as const,
                          label: "あなたの手",
                          value: comparison.own,
                        },
                        ...comparison.top.map((value, index) => ({
                          key: `ai-${index}` as const,
                          label: `AI ${index + 1}位`,
                          value,
                        })),
                      ].map(({ key, label, value }) => {
                        const difference =
                          (value.probability -
                            comparison.own.probability) *
                          100;
                        const sameCards =
                          key !== "own" &&
                          playedCardsSignature(
                            state,
                            value.candidate.actions,
                          ) ===
                            playedCardsSignature(
                              state,
                              comparison.own.candidate.actions,
                            );
                        const sameRefill =
                          candidateRefillDecision(value.candidate.actions) ===
                          candidateRefillDecision(
                            comparison.own.candidate.actions,
                          );
                        return (
                          <button
                            type="button"
                            key={key}
                            className={preview === key ? "selected" : ""}
                            onClick={() => setPreview(key)}
                          >
                            <span>{label}</span>
                            <strong>{roundedProbability(value.probability)}</strong>
                            <small>{describePlan(state, value.candidate.actions)}</small>
                            {sameCards && (
                              <b className="same-cards">
                                {sameRefill
                                  ? "同じカード"
                                  : "同じカード・補充違い"}
                              </b>
                            )}
                            {key !== "own" && (
                              <em>
                                {Math.abs(difference) < 1
                                  ? "差は1ポイント未満"
                                  : `${difference > 0 ? "+" : ""}${Math.round(difference)}ポイント`}
                              </em>
                            )}
                          </button>
                        );
                      })}
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
