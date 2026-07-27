import type { TurnCandidate } from "./value";
import { Action, COLORS, Frame, GameState, positionKey } from "./types";
import {
  candidateFrameContext,
  CompletedTurnV2,
  PublicNegativePileV2,
  V2TrackingState,
  v2EvaluationState,
} from "./v2Tracking";

export const VALUE_CONTEXT_SIZE_V2 = 300;
export const VALUE_CANONICALIZATION_V2 = "strict_residual_v2";
const FRAME_AXIS = 5;
const oneHot = (index: number, size: number): number[] =>
  Array.from({ length: size }, (_, value) => Number(value === index));
const compare = (a: ArrayLike<number>, b: ArrayLike<number>): number => {
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
};
const equal = (a: ArrayLike<number>, b: ArrayLike<number>): boolean =>
  compare(a, b) === 0;

interface Transform {
  vertical: boolean;
  horizontal: boolean;
  mapping: number[];
}
export interface RecordV2 {
  state: GameState;
  viewer: number;
  history: CompletedTurnV2[];
  frame: { startFrame: Frame | null; endFrame: Frame; startBoardCardCount: number };
  piles: PublicNegativePileV2[];
  pending: "no_pending" | "none" | "deck" | "negative_cards";
}

const occupancyKey = (
  state: GameState,
  vertical: boolean,
  horizontal: boolean,
): number[] => {
  const cells = Array.from({ length: 49 }, () => 0);
  Object.entries(state.board).forEach(([key, stack]) => {
    const [oldX, oldY] = key.split(",").map(Number);
    const x = horizontal ? 6 - oldX : oldX;
    const y = vertical ? 6 - oldY : oldY;
    cells[y * 7 + x] += stack.length;
  });
  return cells;
};
const handRankKey = (record: RecordV2, vertical: boolean): number[] => {
  const counts = Array.from({ length: 7 }, () => 0);
  record.state.players[record.viewer].hand.forEach((card) => {
    counts[vertical ? 6 - card.rankIndex : card.rankIndex] += 1;
  });
  return counts;
};
const colorSignature = (
  record: RecordV2,
  oldColor: number,
  vertical: boolean,
  horizontal: boolean,
): number[] => {
  const color = COLORS[oldColor];
  const board = Array.from({ length: 49 }, () => 0);
  Object.entries(record.state.board).forEach(([key, stack]) => {
    const [oldX, oldY] = key.split(",").map(Number);
    const x = horizontal ? 6 - oldX : oldX;
    const y = vertical ? 6 - oldY : oldY;
    board[y * 7 + x] += stack.filter((card) => card.color === color).length;
  });
  const hand = Array.from({ length: 7 }, () => 0);
  record.state.players[record.viewer].hand.forEach((card) => {
    if (card.color === color) {
      hand[vertical ? 6 - card.rankIndex : card.rankIndex] += 1;
    }
  });
  const history = Array.from(
    { length: (3 - record.history.slice(-3).length) * 7 },
    () => 0,
  );
  record.history.slice(-3).forEach((turn) => {
    const counts = Array.from({ length: 7 }, () => 0);
    turn.cards.forEach((card) => {
      if (card.color === color) {
        counts[vertical ? 6 - card.rankIndex : card.rankIndex] += 1;
      }
    });
    history.push(...counts);
  });
  const ownNegative = Array.from({ length: 7 }, () => 0);
  record.state.players[record.viewer].negativeCards.forEach((card) => {
    if (card.color === color) {
      ownNegative[vertical ? 6 - card.rankIndex : card.rankIndex] += 1;
    }
  });
  const opponents = [1, 2, 3].map(
    (offset) =>
      record.piles[(record.viewer + offset) % 4].colorExpected[oldColor],
  );
  return [...board, ...hand, ...history, ...ownNegative, ...opponents];
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
const transforms = (record: RecordV2): Transform[] => {
  let verticals = [false, true];
  const verticalKeys = verticals.map((vertical) => {
    const keys = [false, true].map((horizontal) =>
      occupancyKey(record.state, vertical, horizontal),
    );
    return keys.sort(compare)[0];
  });
  const minVertical = [...verticalKeys].sort(compare)[0];
  verticals = verticals.filter((_, index) =>
    equal(verticalKeys[index], minVertical),
  );
  if (verticals.length > 1) {
    const keys = verticals.map((vertical) => handRankKey(record, vertical));
    const minimum = [...keys].sort(compare)[0];
    verticals = verticals.filter((_, index) => equal(keys[index], minimum));
  }
  const spatial = verticals.flatMap((vertical) =>
    [false, true].map((horizontal) => ({
      vertical,
      horizontal,
      key: occupancyKey(record.state, vertical, horizontal),
    })),
  );
  const minimum = spatial.map((item) => item.key).sort(compare)[0];
  return spatial
    .filter((item) => equal(item.key, minimum))
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
        if (last && equal(signatures[last[0]], signatures[color])) last.push(color);
        else groups.push([color]);
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
const transformedFrame = (frame: Frame, transform: Transform): Frame => ({
  x: transform.horizontal ? 4 - frame.x : frame.x,
  y: transform.vertical ? 4 - frame.y : frame.y,
});
const appendFrame = (
  values: number[],
  start: Frame | null,
  end: Frame,
  boardCount: number,
  transform: Transform,
) => {
  const transformedEnd = transformedFrame(end, transform);
  values.push(Number(Boolean(start)));
  if (start) {
    const transformedStart = transformedFrame(start, transform);
    values.push(...oneHot(transformedStart.x, 5), ...oneHot(transformedStart.y, 5));
  } else values.push(...Array.from({ length: 10 }, () => 0));
  values.push(...oneHot(transformedEnd.x, 5), ...oneHot(transformedEnd.y, 5));
  values.push(
    boardCount / 56,
    start ? Math.abs(end.x - start.x) / 4 : 0,
    start ? Math.abs(end.y - start.y) / 4 : 0,
  );
};
const deckBucket = (count: number): number =>
  count === 0 ? 0 : count <= 6 ? 1 : count <= 18 ? 2 : 3;
const encode = (
  record: RecordV2,
  transform: Transform,
): { board: Float32Array; context: Float32Array } => {
  const board = new Float32Array(29 * 49);
  Object.entries(record.state.board).forEach(([key, stack]) => {
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
  const values: number[] = [];
  const hand = record.state.players[record.viewer].hand
    .map((card) => [
      transform.mapping[COLORS.indexOf(card.color)],
      transform.vertical ? 6 - card.rankIndex : card.rankIndex,
    ])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  for (let slot = 0; slot < 6; slot += 1) {
    const card = hand[slot];
    values.push(...(card ? [1, ...oneHot(card[0], 4), card[1] / 6] : [0, 0, 0, 0, 0, 0]));
  }
  for (let offset = 0; offset < 4; offset += 1) {
    const player = record.state.players[(record.viewer + offset) % 4];
    values.push(player.lossScore / 35, player.hand.length / 6, player.negativeCards.length / 56);
  }
  values.push(
    ...oneHot((record.state.currentPlayerIndex - record.viewer + 4) % 4, 4),
    ...oneHot(["play", "refill", "game_over"].indexOf(record.state.phase), 3),
    record.state.cardsPlayedThisTurn / 2,
    record.state.settlementCount / 10,
    ...oneHot(deckBucket(record.state.deck.length), 4),
    ...oneHot(["no_pending", "none", "deck", "negative_cards"].indexOf(record.pending), 4),
  );
  values.push(...Array.from({ length: (3 - record.history.slice(-3).length) * 49 }, () => 0));
  record.history.slice(-3).forEach((turn) => {
    values.push(1, ...oneHot((turn.playerIndex - record.viewer + 4) % 4, 4), turn.cards.length / 2);
    appendFrame(values, turn.startFrame, turn.endFrame, turn.startBoardCardCount, transform);
    const cards = turn.cards
      .map((card) => [
        transform.mapping[COLORS.indexOf(card.color)],
        transform.vertical ? 6 - card.rankIndex : card.rankIndex,
      ])
      .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    for (let slot = 0; slot < 2; slot += 1) {
      const card = cards[slot];
      values.push(...(card ? [1, ...oneHot(card[0], 4), card[1] / 6] : [0, 0, 0, 0, 0, 0]));
    }
    values.push(
      turn.scoreDelta / 3,
      turn.negativeCardDelta / 9,
      ...oneHot(["not_offered", "none", "deck", "negative_cards"].indexOf(turn.refillResult), 4),
      Number(turn.settlementOccurred),
    );
  });
  appendFrame(values, record.frame.startFrame, record.frame.endFrame, record.frame.startBoardCardCount, transform);
  const own = Array.from({ length: 28 }, () => 0);
  record.state.players[record.viewer].negativeCards.forEach((card) => {
    const color = transform.mapping[COLORS.indexOf(card.color)];
    const rank = transform.vertical ? 6 - card.rankIndex : card.rankIndex;
    own[color * 7 + rank] += 1;
  });
  values.push(...own.map((value) => value / 56));
  for (let offset = 1; offset < 4; offset += 1) {
    const pile = record.piles[(record.viewer + offset) % 4];
    const ranks = transform.vertical ? [...pile.rankExpected].reverse() : pile.rankExpected;
    const colors = Array.from({ length: 4 }, () => 0);
    pile.colorExpected.forEach((count, oldColor) => {
      colors[transform.mapping[oldColor]] = count;
    });
    values.push(...ranks.map((v) => v / 56), ...colors.map((v) => v / 56), Number(pile.exact));
  }
  if (values.length !== VALUE_CONTEXT_SIZE_V2) throw new Error(`V2コンテキスト長: ${values.length}`);
  return { board, context: Float32Array.from(values) };
};
export const canonicalRecordV2 = (record: RecordV2) => {
  let best: { board: Float32Array; context: Float32Array } | null = null;
  for (const transform of transforms(record)) {
    const value = encode(record, transform);
    if (
      !best ||
      compare(value.board, best.board) < 0 ||
      (compare(value.board, best.board) === 0 &&
        compare(value.context, best.context) < 0)
    ) best = value;
  }
  if (!best) throw new Error("V2正規化候補がありません");
  return best;
};

export const encodeCandidatesV2 = (
  candidates: TurnCandidate[],
  viewer: number,
  turnStart: GameState,
  tracking: V2TrackingState,
): { board: Float32Array; context: Float32Array } => {
  const boards = new Float32Array(candidates.length * 29 * 49);
  const contexts = new Float32Array(candidates.length * VALUE_CONTEXT_SIZE_V2);
  candidates.forEach((candidate, index) => {
    const evaluation = v2EvaluationState(turnStart, candidate.actions);
    const value = canonicalRecordV2({
      state: evaluation.state,
      viewer,
      history: tracking.history,
      frame: candidateFrameContext(turnStart, candidate.actions, tracking),
      piles: tracking.negativePiles,
      pending: evaluation.pendingRefillSource,
    });
    boards.set(value.board, index * 29 * 49);
    contexts.set(value.context, index * VALUE_CONTEXT_SIZE_V2);
  });
  return { board: boards, context: contexts };
};
