import {
  applyKnownLegalAction,
  legalActions,
} from "./game";
import {
  Action,
  Card,
  COLORS,
  GameState,
  PlaceCardAction,
  RecentPlacement,
  RefillAction,
  positionKey,
} from "./types";
import { canonicalizeValueTensors } from "./valueCanonicalization";
import { v2EvaluationState } from "./v2Tracking";

export const BOARD_CHANNELS = 29;
export const CONTEXT_SIZE = 81;
export const HISTORY_SIZE = 2;

export interface TurnCandidate {
  actions: Action[];
  state: GameState;
  history: RecentPlacement[];
}

export interface TurnEvaluation {
  candidate: TurnCandidate;
  probability: number;
}

export const playedCardsSignature = (
  turnStart: GameState,
  actions: Action[],
): string => {
  let state = turnStart;
  const cards: string[] = [];
  actions.forEach((action) => {
    if (action.type === "place") {
      const card =
        state.players[state.currentPlayerIndex].hand[action.handIndex];
      cards.push(`${card.color}:${card.rankIndex}`);
    }
    state = applyKnownLegalAction(state, action);
  });
  return cards.sort().join("|");
};

export const candidateRefillDecision = (actions: Action[]): string =>
  actions.find((action): action is RefillAction => action.type === "refill")
    ?.source ?? "none";

export const candidateGroupSignature = (
  turnStart: GameState,
  actions: Action[],
): string =>
  `${playedCardsSignature(turnStart, actions)}::refill:${candidateRefillDecision(actions)}`;

/**
 * Collapse frame and play-order variants while keeping each refill decision
 * as an independent candidate group.
 */
export const topDistinctCandidateEvaluations = (
  turnStart: GameState,
  evaluations: TurnEvaluation[],
  limit = 3,
): TurnEvaluation[] => {
  const bestByDecision = new Map<string, TurnEvaluation>();
  evaluations.forEach((evaluation) => {
    const signature = candidateGroupSignature(
      turnStart,
      evaluation.candidate.actions,
    );
    const current = bestByDecision.get(signature);
    if (!current || evaluation.probability > current.probability) {
      bestByDecision.set(signature, evaluation);
    }
  });
  return [...bestByDecision.values()]
    .sort((left, right) => right.probability - left.probability)
    .slice(0, limit);
};

const placementWithHistory = (
  state: GameState,
  action: PlaceCardAction,
  history: RecentPlacement[],
): { state: GameState; history: RecentPlacement[] } => {
  const playerIndex = state.currentPlayerIndex;
  const card = state.players[playerIndex].hand[action.handIndex];
  const after = applyKnownLegalAction(state, action);
  return {
    state: after,
    history: [
      ...history,
      {
        playerIndex,
        card,
        scoreDelta:
          state.players[playerIndex].lossScore -
          after.players[playerIndex].lossScore,
        negativeCardDelta:
          after.players[playerIndex].negativeCards.length -
          state.players[playerIndex].negativeCards.length,
      },
    ].slice(-HISTORY_SIZE),
  };
};

export const applyActionTrackingHistory = (
  state: GameState,
  action: Action,
  history: RecentPlacement[],
): { state: GameState; history: RecentPlacement[] } => {
  if (action.type === "place") return placementWithHistory(state, action, history);
  return { state: applyKnownLegalAction(state, action), history };
};

const receivedSignature = (
  before: GameState,
  after: GameState,
  playerIndex: number,
): string =>
  after.players[playerIndex].negativeCards
    .slice(before.players[playerIndex].negativeCards.length)
    .map((card) => `${card.color}:${card.rankIndex}`)
    .sort()
    .join("|");

/** Match the Python value policy's representative-frame reduction. */
const representativePlacements = (state: GameState): PlaceCardAction[] => {
  const placements = legalActions(state).filter(
    (action): action is PlaceCardAction => action.type === "place",
  );
  const groups = new Map<string, PlaceCardAction[]>();
  placements.forEach((action) => {
    const key = `${action.handIndex}:${positionKey(action.position)}`;
    groups.set(key, [...(groups.get(key) ?? []), action]);
  });
  const result: PlaceCardAction[] = [];
  groups.forEach((actions) => {
    const playerIndex = state.currentPlayerIndex;
    let minimum = Number.POSITIVE_INFINITY;
    const representatives = new Map<string, PlaceCardAction>();
    for (const action of actions) {
      const after = applyKnownLegalAction(state, action);
      const loss =
        after.players[playerIndex].negativeCards.length -
        state.players[playerIndex].negativeCards.length;
      if (loss === 0) {
        result.push(action);
        return;
      }
      if (loss < minimum) {
        minimum = loss;
        representatives.clear();
      }
      if (loss === minimum) {
        representatives.set(
          receivedSignature(state, after, playerIndex),
          action,
        );
      }
    }
    result.push(...representatives.values());
  });
  return result;
};

export const enumerateTurnCandidates = (
  state: GameState,
  history: RecentPlacement[] = [],
): TurnCandidate[] => {
  if (state.phase !== "play" || state.cardsPlayedThisTurn !== 0) {
    throw new Error("候補生成にはターン開始状態が必要です");
  }
  const result: TurnCandidate[] = [];
  const appendCompleted = (
    actions: Action[],
    candidateState: GameState,
    candidateHistory: RecentPlacement[],
  ) => {
    const legalRefills = legalActions(candidateState).filter(
      (action): action is RefillAction => action.type === "refill",
    );
    if (legalRefills.length) {
      legalRefills.forEach((refill) => {
        result.push({
          actions: [...actions, refill],
          state: applyKnownLegalAction(candidateState, refill),
          history: candidateHistory,
        });
      });
      return;
    }
    result.push({
      actions,
      state: candidateState,
      history: candidateHistory,
    });
  };
  for (const first of representativePlacements(state)) {
    const afterFirst = placementWithHistory(state, first, history);
    if (
      legalActions(afterFirst.state).some((action) => action.type === "end_turn")
    ) {
      appendCompleted(
        [first, { type: "end_turn" }],
        applyKnownLegalAction(afterFirst.state, { type: "end_turn" }),
        afterFirst.history,
      );
    }
    for (const second of representativePlacements(afterFirst.state)) {
      const afterSecond = placementWithHistory(
        afterFirst.state,
        second,
        afterFirst.history,
      );
      appendCompleted(
        [first, second],
        afterSecond.state,
        afterSecond.history,
      );
    }
  }
  return result;
};

const oneHot = (index: number, size: number): number[] =>
  Array.from({ length: size }, (_, value) => (value === index ? 1 : 0));

export const encodeBoard = (state: GameState): Float32Array => {
  const tensor = new Float32Array(BOARD_CHANNELS * 7 * 7);
  Object.entries(state.board).forEach(([key, stack]) => {
    const [x, y] = key.split(",").map(Number);
    stack.forEach((card) => {
      const channel = COLORS.indexOf(card.color) * 7 + card.rankIndex;
      tensor[(channel * 7 + y) * 7 + x] += 1;
      tensor[(28 * 7 + y) * 7 + x] += 1;
    });
  });
  return tensor;
};

export const encodeContext = (
  state: GameState,
  viewer: number,
  history: RecentPlacement[],
): Float32Array => {
  const values: number[] = [];
  const ownHand = state.players[viewer].hand;
  for (let slot = 0; slot < 6; slot += 1) {
    const card = ownHand[slot];
    values.push(
      ...(card
        ? [1, ...oneHot(COLORS.indexOf(card.color), 4), card.rankIndex / 6]
        : [0, 0, 0, 0, 0, 0]),
    );
  }
  for (let offset = 0; offset < 4; offset += 1) {
    const player = state.players[(viewer + offset) % 4];
    values.push(
      player.lossScore / 35,
      player.hand.length / 6,
      player.negativeCards.length / 56,
    );
  }
  values.push(
    ...oneHot((state.currentPlayerIndex - viewer + 4) % 4, 4),
    ...oneHot(["play", "refill", "game_over"].indexOf(state.phase), 3),
    state.cardsPlayedThisTurn / 2,
    state.settlementCount / 10,
  );
  history.slice(-HISTORY_SIZE).forEach((placement) => {
    values.push(
      1,
      ...oneHot((placement.playerIndex - viewer + 4) % 4, 4),
      ...oneHot(COLORS.indexOf(placement.card.color), 4),
      placement.card.rankIndex / 6,
      placement.scoreDelta / 3,
      placement.negativeCardDelta / 9,
    );
  });
  const missing = HISTORY_SIZE - Math.min(HISTORY_SIZE, history.length);
  values.push(...Array.from({ length: missing * 12 }, () => 0));
  if (values.length !== CONTEXT_SIZE) {
    throw new Error(`AIコンテキスト長が不正です: ${values.length}`);
  }
  return Float32Array.from(values);
};

export const encodeCandidates = (
  candidates: TurnCandidate[],
  viewer: number,
): { board: Float32Array; context: Float32Array } => {
  const board = new Float32Array(candidates.length * BOARD_CHANNELS * 7 * 7);
  const context = new Float32Array(candidates.length * CONTEXT_SIZE);
  candidates.forEach((candidate, index) => {
    board.set(encodeBoard(candidate.state), index * BOARD_CHANNELS * 7 * 7);
    context.set(
      encodeContext(candidate.state, viewer, candidate.history),
      index * CONTEXT_SIZE,
    );
  });
  return canonicalizeValueTensors(board, context);
};

export const encodeCandidatesV1AtDecisionBoundary = (
  candidates: TurnCandidate[],
  viewer: number,
  turnStart: GameState,
): { board: Float32Array; context: Float32Array } => {
  const board = new Float32Array(candidates.length * BOARD_CHANNELS * 7 * 7);
  const context = new Float32Array(candidates.length * CONTEXT_SIZE);
  candidates.forEach((candidate, index) => {
    const evaluationState = v2EvaluationState(
      turnStart,
      candidate.actions,
    ).state;
    board.set(encodeBoard(evaluationState), index * BOARD_CHANNELS * 7 * 7);
    context.set(
      encodeContext(evaluationState, viewer, candidate.history),
      index * CONTEXT_SIZE,
    );
  });
  return canonicalizeValueTensors(board, context);
};

export const completeHumanCandidate = (
  turnStart: GameState,
  pendingActions: PlaceCardAction[],
  history: RecentPlacement[],
  plannedRefill: RefillAction | null = null,
): TurnCandidate | null => {
  if (!pendingActions.length) return null;
  let state = turnStart;
  let nextHistory = history;
  pendingActions.forEach((action) => {
    const applied = placementWithHistory(state, action, nextHistory);
    state = applied.state;
    nextHistory = applied.history;
  });
  const actions: Action[] = [...pendingActions];
  if (pendingActions.length === 1) {
    if (!legalActions(state).some((action) => action.type === "end_turn")) {
      return null;
    }
    actions.push({ type: "end_turn" });
    state = applyKnownLegalAction(state, { type: "end_turn" });
  }
  const legalRefills = legalActions(state).filter(
    (action): action is RefillAction => action.type === "refill",
  );
  if (legalRefills.length) {
    if (
      !plannedRefill ||
      !legalRefills.some(
        (action) => action.source === plannedRefill.source,
      )
    ) {
      return null;
    }
    actions.push(plannedRefill);
    state = applyKnownLegalAction(state, plannedRefill);
  }
  return { actions, state, history: nextHistory };
};

export const actionCard = (
  state: GameState,
  action: PlaceCardAction,
): Card => state.players[state.currentPlayerIndex].hand[action.handIndex];
