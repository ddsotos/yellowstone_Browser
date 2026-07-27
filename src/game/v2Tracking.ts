import { applyKnownLegalAction } from "./game";
import {
  Action,
  Card,
  COLORS,
  Frame,
  GameState,
  PlaceCardAction,
} from "./types";

export type RefillResult =
  | "not_offered"
  | "none"
  | "deck"
  | "negative_cards";

export interface CompletedTurnV2 {
  playerIndex: number;
  cards: Card[];
  startFrame: Frame | null;
  endFrame: Frame;
  startBoardCardCount: number;
  scoreDelta: number;
  negativeCardDelta: number;
  settlementOccurred: boolean;
  refillResult: RefillResult;
}

export interface PublicNegativePileV2 {
  rankExpected: number[];
  colorExpected: number[];
  exact: boolean;
}

interface ActiveTurnV2 {
  playerIndex: number;
  cards: Card[];
  startFrame: Frame | null;
  endFrame: Frame;
  startBoardCardCount: number;
  scoreDelta: number;
  negativeCardDelta: number;
  settlementOccurred: boolean;
}

export interface V2TrackingState {
  history: CompletedTurnV2[];
  currentFrame: Frame | null;
  activeTurn: ActiveTurnV2 | null;
  negativePiles: PublicNegativePileV2[];
}

export const createV2Tracking = (playerCount = 4): V2TrackingState => ({
  history: [],
  currentFrame: null,
  activeTurn: null,
  negativePiles: Array.from({ length: playerCount }, () => ({
    rankExpected: Array.from({ length: 7 }, () => 0),
    colorExpected: Array.from({ length: 4 }, () => 0),
    exact: true,
  })),
});

const boardCardCount = (state: GameState): number =>
  Object.values(state.board).reduce((sum, stack) => sum + stack.length, 0);

const finishTurn = (
  tracking: V2TrackingState,
  refillResult: RefillResult,
): V2TrackingState => {
  const active = tracking.activeTurn;
  if (!active) return tracking;
  const completed: CompletedTurnV2 = { ...active, refillResult };
  return {
    ...tracking,
    history: [...tracking.history, completed].slice(-3),
    currentFrame: active.endFrame,
    activeTurn: null,
  };
};

export const observeV2Action = (
  tracking: V2TrackingState,
  before: GameState,
  action: Action,
  after: GameState,
): V2TrackingState => {
  let next = structuredClone(tracking) as V2TrackingState;
  if (after.settlementCount > before.settlementCount) {
    next.negativePiles = next.negativePiles.map(() => ({
      rankExpected: Array.from({ length: 7 }, () => 0),
      colorExpected: Array.from({ length: 4 }, () => 0),
      exact: true,
    }));
  } else if (action.type === "place") {
    const playerIndex = before.currentPlayerIndex;
    const oldCount = before.players[playerIndex].negativeCards.length;
    const received =
      after.players[playerIndex].negativeCards.slice(oldCount);
    received.forEach((card) => {
      next.negativePiles[playerIndex].rankExpected[card.rankIndex] += 1;
      next.negativePiles[playerIndex].colorExpected[
        COLORS.indexOf(card.color)
      ] += 1;
    });
  } else if (action.type === "refill" && action.source === "negative_cards") {
    const playerIndex = before.currentPlayerIndex;
    const oldCount = before.players[playerIndex].negativeCards.length;
    const newCount = after.players[playerIndex].negativeCards.length;
    if (oldCount > 0) {
      const factor = newCount / oldCount;
      next.negativePiles[playerIndex].rankExpected =
        next.negativePiles[playerIndex].rankExpected.map(
          (value) => value * factor,
        );
      next.negativePiles[playerIndex].colorExpected =
        next.negativePiles[playerIndex].colorExpected.map(
          (value) => value * factor,
        );
      next.negativePiles[playerIndex].exact = newCount === 0;
    }
  }

  if (action.type === "place") {
    const playerIndex = before.currentPlayerIndex;
    const card = before.players[playerIndex].hand[action.handIndex];
    const active =
      next.activeTurn ??
      ({
        playerIndex,
        cards: [],
        startFrame: next.currentFrame,
        endFrame: action.frame,
        startBoardCardCount: boardCardCount(before),
        scoreDelta: 0,
        negativeCardDelta: 0,
        settlementOccurred: false,
      } satisfies ActiveTurnV2);
    active.cards.push(card);
    active.endFrame = action.frame;
    active.scoreDelta +=
      before.players[playerIndex].lossScore -
      after.players[playerIndex].lossScore;
    active.negativeCardDelta +=
      after.players[playerIndex].negativeCards.length -
      before.players[playerIndex].negativeCards.length;
    next.activeTurn = active;
    return next;
  }

  if (next.activeTurn) {
    next.activeTurn.settlementOccurred ||= after.settlementCount >
      before.settlementCount;
  }
  if (action.type === "end_turn") {
    return after.phase === "refill"
      ? next
      : finishTurn(next, "not_offered");
  }
  if (action.type === "refill" && next.activeTurn) {
    return finishTurn(next, action.source);
  }
  return next;
};

export const replayV2Actions = (
  start: GameState,
  actions: Action[],
  tracking: V2TrackingState,
): { state: GameState; tracking: V2TrackingState } => {
  let state = start;
  let nextTracking = tracking;
  actions.forEach((action) => {
    const after = applyKnownLegalAction(state, action);
    nextTracking = observeV2Action(nextTracking, state, action, after);
    state = after;
  });
  return { state, tracking: nextTracking };
};

export const candidateFrameContext = (
  turnStart: GameState,
  actions: Action[],
  tracking: V2TrackingState,
): {
  startFrame: Frame | null;
  endFrame: Frame;
  startBoardCardCount: number;
} => {
  const placements = actions.filter(
    (action): action is PlaceCardAction => action.type === "place",
  );
  const last = placements.at(-1);
  if (!last) throw new Error("V2候補に配置がありません");
  return {
    startFrame: tracking.currentFrame,
    endFrame: last.frame,
    startBoardCardCount: boardCardCount(turnStart),
  };
};

export const v2EvaluationState = (
  turnStart: GameState,
  actions: Action[],
): {
  state: GameState;
  pendingRefillSource: "no_pending" | "none" | "deck" | "negative_cards";
} => {
  let state = turnStart;
  for (const action of actions) {
    if (action.type === "refill") {
      return { state, pendingRefillSource: action.source };
    }
    state = applyKnownLegalAction(state, action);
  }
  return { state, pendingRefillSource: "no_pending" };
};
