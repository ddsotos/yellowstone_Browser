import { applyKnownLegalAction } from "./game";
import { TurnCandidate } from "./value";
import { Card, COLORS, GameState } from "./types";
import {
  CompletedTurnV2,
  V2TrackingState,
  v2EvaluationState,
} from "./v2Tracking";

export const BOARD_CHANNELS_V2_LITE = 58;
export const VALUE_CONTEXT_SIZE_V2_LITE = 138;
export const ACTION_DELTA_CONTEXT_SIZE = 150;

export interface LiteTransform {
  vertical: boolean;
  horizontal: boolean;
  mapping: number[];
}

interface LiteRecord {
  before: GameState;
  after: GameState;
  viewer: number;
  history: CompletedTurnV2[];
  pending: "no_pending" | "none" | "deck" | "negative_cards";
}

const oneHot = (index: number, size: number): number[] =>
  Array.from({ length: size }, (_, value) => Number(value === index));

const compare = (left: ArrayLike<number>, right: ArrayLike<number>): number => {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
  }
  return 0;
};

const permutations = (values: number[]): number[][] =>
  values.length <= 1
    ? [values]
    : values.flatMap((value, index) =>
        permutations(values.filter((_, item) => item !== index)).map((rest) => [
          value,
          ...rest,
        ]),
      );

const occupancyKey = (
  state: GameState,
  vertical: boolean,
  horizontal: boolean,
): number[] => {
  const result = Array.from({ length: 49 }, () => 0);
  Object.entries(state.board).forEach(([key, stack]) => {
    const [oldX, oldY] = key.split(",").map(Number);
    const x = horizontal ? 6 - oldX : oldX;
    const y = vertical ? 6 - oldY : oldY;
    result[y * 7 + x] += stack.length;
  });
  return result;
};

const handRankKey = (record: LiteRecord, vertical: boolean): number[] => {
  const counts = Array.from({ length: 7 }, () => 0);
  record.after.players[record.viewer].hand.forEach((card) => {
    counts[vertical ? 6 - card.rankIndex : card.rankIndex] += 1;
  });
  return counts;
};

const boardColor = (
  state: GameState,
  oldColor: number,
  vertical: boolean,
  horizontal: boolean,
): number[] => {
  const color = COLORS[oldColor];
  const result = Array.from({ length: 49 }, () => 0);
  Object.entries(state.board).forEach(([key, stack]) => {
    const [oldX, oldY] = key.split(",").map(Number);
    const x = horizontal ? 6 - oldX : oldX;
    const y = vertical ? 6 - oldY : oldY;
    result[y * 7 + x] += stack.filter((card) => card.color === color).length;
  });
  return result;
};

const colorSignature = (
  record: LiteRecord,
  oldColor: number,
  vertical: boolean,
  horizontal: boolean,
): number[] => {
  const after = boardColor(record.after, oldColor, vertical, horizontal);
  const before = boardColor(record.before, oldColor, vertical, horizontal);
  const delta = after.map((value, index) => value - before[index]);
  const color = COLORS[oldColor];
  const rankCounts = (cards: Card[]): number[] => {
    const counts = Array.from({ length: 7 }, () => 0);
    cards.forEach((card) => {
      if (card.color === color) {
        counts[vertical ? 6 - card.rankIndex : card.rankIndex] += 1;
      }
    });
    return counts;
  };
  const history = Array.from(
    { length: (2 - record.history.slice(-2).length) * 7 },
    () => 0,
  );
  record.history.slice(-2).forEach((turn) => history.push(...rankCounts(turn.cards)));
  return [
    ...after,
    ...delta,
    ...rankCounts(record.after.players[record.viewer].hand),
    ...history,
    ...rankCounts(record.after.players[record.viewer].negativeCards),
  ];
};

const transforms = (record: LiteRecord): LiteTransform[] => {
  let verticals = [false, true];
  const verticalKeys = verticals.map((vertical) =>
    [false, true]
      .map((horizontal) => occupancyKey(record.after, vertical, horizontal))
      .sort(compare)[0],
  );
  const minimumVertical = [...verticalKeys].sort(compare)[0];
  verticals = verticals.filter(
    (_, index) => compare(verticalKeys[index], minimumVertical) === 0,
  );
  if (verticals.length > 1) {
    const keys = verticals.map((vertical) => handRankKey(record, vertical));
    const minimum = [...keys].sort(compare)[0];
    verticals = verticals.filter((_, index) => compare(keys[index], minimum) === 0);
  }
  const spatial = verticals.flatMap((vertical) =>
    [false, true].map((horizontal) => ({
      vertical,
      horizontal,
      key: occupancyKey(record.after, vertical, horizontal),
    })),
  );
  const minimumSpatial = spatial.map((value) => value.key).sort(compare)[0];
  return spatial
    .filter((value) => compare(value.key, minimumSpatial) === 0)
    .flatMap(({ vertical, horizontal }) => {
      const signatures = [0, 1, 2, 3].map((color) =>
        colorSignature(record, color, vertical, horizontal),
      );
      const ordered = [0, 1, 2, 3].sort((a, b) =>
        compare(signatures[a], signatures[b]),
      );
      const groups: number[][] = [];
      ordered.forEach((color) => {
        const last = groups.at(-1);
        if (last && compare(signatures[last[0]], signatures[color]) === 0) {
          last.push(color);
        } else {
          groups.push([color]);
        }
      });
      let orders: number[][] = [[]];
      groups.forEach((group) => {
        orders = orders.flatMap((prefix) =>
          permutations(group).map((suffix) => [...prefix, ...suffix]),
        );
      });
      return orders.map((oldInNewOrder) => {
        const mapping = Array.from({ length: 4 }, () => 0);
        oldInNewOrder.forEach((oldColor, newColor) => {
          mapping[oldColor] = newColor;
        });
        return { vertical, horizontal, mapping };
      });
    });
};

const encodeBoard = (state: GameState, transform: LiteTransform): Float32Array => {
  const board = new Float32Array(29 * 49);
  Object.entries(state.board).forEach(([key, stack]) => {
    const [oldX, oldY] = key.split(",").map(Number);
    const x = transform.horizontal ? 6 - oldX : oldX;
    const y = transform.vertical ? 6 - oldY : oldY;
    stack.forEach((card) => {
      const rank = transform.vertical ? 6 - card.rankIndex : card.rankIndex;
      const color = transform.mapping[COLORS.indexOf(card.color)];
      board[(color * 7 + rank) * 49 + y * 7 + x] += 1;
      board[28 * 49 + y * 7 + x] += 1;
    });
  });
  return board;
};

const playerSummaries = (state: GameState, viewer: number): number[] =>
  Array.from({ length: 4 }, (_, offset) => {
    const player = state.players[(viewer + offset) % state.players.length];
    return [
      player.lossScore / 35,
      player.hand.length / 6,
      player.negativeCards.length / 56,
    ];
  }).flat();

const deckBucket = (count: number): number =>
  count === 0 ? 0 : count <= 6 ? 1 : count <= 18 ? 2 : 3;

const encode = (
  record: LiteRecord,
  transform: LiteTransform,
): { board: Float32Array; context: Float32Array; transform: LiteTransform } => {
  const afterBoard = encodeBoard(record.after, transform);
  const beforeBoard = encodeBoard(record.before, transform);
  const board = new Float32Array(58 * 49);
  board.set(afterBoard);
  afterBoard.forEach((value, index) => {
    board[29 * 49 + index] = value - beforeBoard[index];
  });
  const values: number[] = [];
  const hand = record.after.players[record.viewer].hand
    .map((card) => [
      transform.mapping[COLORS.indexOf(card.color)],
      transform.vertical ? 6 - card.rankIndex : card.rankIndex,
    ])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  for (let slot = 0; slot < 6; slot += 1) {
    const card = hand[slot];
    values.push(
      ...(card
        ? [1, ...oneHot(card[0], 4), card[1] / 6]
        : [0, 0, 0, 0, 0, 0]),
    );
  }
  values.push(
    ...playerSummaries(record.after, record.viewer),
    ...oneHot(
      (record.after.currentPlayerIndex - record.viewer + 4) % 4,
      4,
    ),
    ...oneHot(["play", "refill", "game_over"].indexOf(record.after.phase), 3),
    record.after.cardsPlayedThisTurn / 2,
    record.after.settlementCount / 10,
    ...oneHot(deckBucket(record.after.deck.length), 4),
    ...oneHot(
      ["no_pending", "none", "deck", "negative_cards"].indexOf(record.pending),
      4,
    ),
  );
  const history = record.history.slice(-2);
  values.push(...Array.from({ length: (2 - history.length) * 25 }, () => 0));
  history.forEach((turn) => {
    values.push(
      1,
      ...oneHot((turn.playerIndex - record.viewer + 4) % 4, 4),
      turn.cards.length / 2,
    );
    const cards = turn.cards
      .map((card) => [
        transform.mapping[COLORS.indexOf(card.color)],
        transform.vertical ? 6 - card.rankIndex : card.rankIndex,
      ])
      .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    for (let slot = 0; slot < 2; slot += 1) {
      const card = cards[slot];
      values.push(
        ...(card
          ? [1, ...oneHot(card[0], 4), card[1] / 6]
          : [0, 0, 0, 0, 0, 0]),
      );
    }
    values.push(
      turn.scoreDelta / 3,
      turn.negativeCardDelta / 9,
      ...oneHot(
        ["not_offered", "none", "deck", "negative_cards"].indexOf(
          turn.refillResult,
        ),
        4,
      ),
      Number(turn.settlementOccurred),
    );
  });
  const ranks = Array.from({ length: 7 }, () => 0);
  const colors = Array.from({ length: 4 }, () => 0);
  record.after.players[record.viewer].negativeCards.forEach((card) => {
    ranks[transform.vertical ? 6 - card.rankIndex : card.rankIndex] += 1;
    colors[transform.mapping[COLORS.indexOf(card.color)]] += 1;
  });
  values.push(
    ...ranks.map((value) => value / 56),
    ...colors.map((value) => value / 56),
    ...playerSummaries(record.before, record.viewer),
  );
  if (values.length !== VALUE_CONTEXT_SIZE_V2_LITE) {
    throw new Error(`V2-liteコンテキスト長: ${values.length}`);
  }
  return { board, context: Float32Array.from(values), transform };
};

export const canonicalRecordV2Lite = (record: LiteRecord) => {
  let best:
    | { board: Float32Array; context: Float32Array; transform: LiteTransform }
    | undefined;
  transforms(record).forEach((transform) => {
    const candidate = encode(record, transform);
    if (
      !best ||
      compare(candidate.board, best.board) < 0 ||
      (compare(candidate.board, best.board) === 0 &&
        compare(candidate.context, best.context) < 0)
    ) {
      best = candidate;
    }
  });
  if (!best) throw new Error("V2-lite正規化候補がありません");
  return best;
};

const recordFor = (
  candidate: TurnCandidate,
  viewer: number,
  turnStart: GameState,
  tracking: V2TrackingState,
): LiteRecord => {
  const evaluation = v2EvaluationState(turnStart, candidate.actions);
  return {
    before: turnStart,
    after: evaluation.state,
    viewer,
    history: tracking.history.slice(-2),
    pending: evaluation.pendingRefillSource,
  };
};

export const encodeCandidatesV2Lite = (
  candidates: TurnCandidate[],
  viewer: number,
  turnStart: GameState,
  tracking: V2TrackingState,
): { board: Float32Array; context: Float32Array } => {
  const board = new Float32Array(candidates.length * 58 * 49);
  const context = new Float32Array(candidates.length * VALUE_CONTEXT_SIZE_V2_LITE);
  candidates.forEach((candidate, index) => {
    const value = canonicalRecordV2Lite(
      recordFor(candidate, viewer, turnStart, tracking),
    );
    board.set(value.board, index * 58 * 49);
    context.set(value.context, index * VALUE_CONTEXT_SIZE_V2_LITE);
  });
  return { board, context };
};

export const playedCards = (
  turnStart: GameState,
  actions: TurnCandidate["actions"],
): Card[] => {
  let state = turnStart;
  const cards: Card[] = [];
  actions.forEach((action) => {
    if (action.type === "place") {
      cards.push(state.players[state.currentPlayerIndex].hand[action.handIndex]);
    }
    if (action.type !== "refill") state = applyKnownLegalAction(state, action);
  });
  return cards;
};

export const encodeCandidatesActionDelta = (
  candidates: TurnCandidate[],
  viewer: number,
  turnStart: GameState,
  tracking: V2TrackingState,
): { board: Float32Array; context: Float32Array } => {
  const board = new Float32Array(candidates.length * 58 * 49);
  const context = new Float32Array(candidates.length * ACTION_DELTA_CONTEXT_SIZE);
  candidates.forEach((candidate, index) => {
    const record = recordFor(candidate, viewer, turnStart, tracking);
    record.pending = "no_pending";
    const value = canonicalRecordV2Lite(record);
    const values = [...value.context];
    const cards = playedCards(turnStart, candidate.actions);
    values.push(...encodeActionCards(cards, value.transform));
    board.set(value.board, index * 58 * 49);
    context.set(values, index * ACTION_DELTA_CONTEXT_SIZE);
  });
  return { board, context };
};

export const encodeActionCards = (
  cards: Card[],
  transform: LiteTransform,
): number[] => {
  const values: number[] = [];
  for (let slot = 0; slot < 2; slot += 1) {
    const card = cards[slot];
    if (!card) {
      values.push(0, 0, 0, 0, 0, 0);
      continue;
    }
    const oldColor = COLORS.indexOf(card.color);
    const rank = transform.vertical ? 6 - card.rankIndex : card.rankIndex;
    values.push(
      1,
      ...oneHot(transform.mapping[oldColor], 4),
      rank / 6,
    );
  }
  return values;
};
