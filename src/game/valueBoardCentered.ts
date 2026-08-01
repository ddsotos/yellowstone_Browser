import type { TurnCandidate } from "./value";
import { v2EvaluationState } from "./v2Tracking";
import { COLORS, GameState, RecentPlacement } from "./types";

export const BOARD_CENTERED_BOARD_CHANNELS = 1;
export const BOARD_CENTERED_BOARD_SIZE = 3;
export const BOARD_CENTERED_CONTEXT_SIZE = 173;

const BOARD_SIZE = 7;
const HAND_SIZE = 6;
const HISTORY_SIZE = 2;
const RANK_DELTA_MIN = -6;
const RANK_DELTA_MAX = 3;
const RANK_DELTA_CLASSES = RANK_DELTA_MAX - RANK_DELTA_MIN + 1;

interface Transform {
  vertical: boolean;
  horizontal: boolean;
  mapping: number[];
}

const oneHot = (index: number, size: number): number[] => {
  if (index < 0 || index >= size) {
    throw new Error(`b-center class out of range: ${index} / ${size}`);
  }
  return Array.from({ length: size }, (_, value) => Number(value === index));
};

const rankDeltaOneHot = (delta: number): number[] => {
  if (delta < RANK_DELTA_MIN || delta > RANK_DELTA_MAX) {
    throw new Error(`b-center rank delta outside -6..3: ${delta}`);
  }
  return oneHot(delta - RANK_DELTA_MIN, RANK_DELTA_CLASSES);
};

const compare = (left: ArrayLike<number>, right: ArrayLike<number>): number => {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference) return difference < 0 ? -1 : 1;
  }
  return 0;
};

const occupancyKey = (
  state: GameState,
  vertical: boolean,
  horizontal: boolean,
): number[] => {
  const cells = Array.from({ length: BOARD_SIZE * BOARD_SIZE }, () => 0);
  Object.entries(state.board).forEach(([key, stack]) => {
    const [oldX, oldY] = key.split(",").map(Number);
    const x = horizontal ? 6 - oldX : oldX;
    const y = vertical ? 6 - oldY : oldY;
    cells[y * BOARD_SIZE + x] += stack.length;
  });
  return cells;
};

const handRankKey = (
  state: GameState,
  viewer: number,
  vertical: boolean,
): number[] => {
  const counts = Array.from({ length: BOARD_SIZE }, () => 0);
  state.players[viewer].hand.forEach((card) => {
    counts[vertical ? 6 - card.rankIndex : card.rankIndex] += 1;
  });
  return counts;
};

const colorSignature = (
  state: GameState,
  viewer: number,
  history: RecentPlacement[],
  oldColor: number,
  vertical: boolean,
  horizontal: boolean,
): number[] => {
  const color = COLORS[oldColor];
  const board = Array.from({ length: BOARD_SIZE * BOARD_SIZE }, () => 0);
  Object.entries(state.board).forEach(([key, stack]) => {
    const [oldX, oldY] = key.split(",").map(Number);
    const x = horizontal ? 6 - oldX : oldX;
    const y = vertical ? 6 - oldY : oldY;
    board[y * BOARD_SIZE + x] += stack.filter((card) => card.color === color).length;
  });
  const hand = Array.from({ length: BOARD_SIZE }, () => 0);
  state.players[viewer].hand.forEach((card) => {
    if (card.color === color) {
      hand[vertical ? 6 - card.rankIndex : card.rankIndex] += 1;
    }
  });
  const recent = history.slice(-HISTORY_SIZE);
  const historyKey = Array.from(
    { length: (HISTORY_SIZE - recent.length) * BOARD_SIZE },
    () => 0,
  );
  recent.forEach((placement) => {
    const counts = Array.from({ length: BOARD_SIZE }, () => 0);
    if (placement.card.color === color) {
      counts[vertical ? 6 - placement.card.rankIndex : placement.card.rankIndex] += 1;
    }
    historyKey.push(...counts);
  });
  return [...board, ...hand, ...historyKey];
};

const residualTransform = (
  state: GameState,
  viewer: number,
  history: RecentPlacement[],
): Transform => {
  let verticals = [false, true];
  const verticalKeys = verticals.map((vertical) =>
    [false, true]
      .map((horizontal) => occupancyKey(state, vertical, horizontal))
      .sort(compare)[0],
  );
  const minimumVertical = [...verticalKeys].sort(compare)[0];
  verticals = verticals.filter(
    (_, index) => compare(verticalKeys[index], minimumVertical) === 0,
  );
  if (verticals.length > 1) {
    const keys = verticals.map((vertical) => handRankKey(state, viewer, vertical));
    const minimum = [...keys].sort(compare)[0];
    verticals = verticals.filter((_, index) => compare(keys[index], minimum) === 0);
  }

  const spatial = verticals.flatMap((vertical) =>
    [false, true].map((horizontal) => ({
      vertical,
      horizontal,
      key: occupancyKey(state, vertical, horizontal),
    })),
  );
  const minimumSpatial = spatial.map((value) => value.key).sort(compare)[0];
  const transforms = spatial
    .filter((value) => compare(value.key, minimumSpatial) === 0)
    .map(({ vertical, horizontal }) => {
      const signatures = [0, 1, 2, 3].map((color) =>
        colorSignature(state, viewer, history, color, vertical, horizontal),
      );
      const ordered = [0, 1, 2, 3].sort((a, b) =>
        compare(signatures[a], signatures[b]),
      );
      const mapping = Array.from({ length: 4 }, () => 0);
      ordered.forEach((oldColor, newColor) => {
        mapping[oldColor] = newColor;
      });
      return { vertical, horizontal, mapping };
    });
  return transforms.sort(
    (a, b) =>
      Number(a.vertical) - Number(b.vertical) ||
      Number(a.horizontal) - Number(b.horizontal) ||
      compare(a.mapping, b.mapping),
  )[0];
};

const encodeCentered = (
  state: GameState,
  viewer: number,
  history: RecentPlacement[],
): { board: Float32Array; context: Float32Array } => {
  const transform = residualTransform(state, viewer, history);
  const totals = Array.from({ length: BOARD_SIZE }, () =>
    Array.from({ length: BOARD_SIZE }, () => 0),
  );
  Object.entries(state.board).forEach(([key, stack]) => {
    const [oldX, oldY] = key.split(",").map(Number);
    const x = transform.horizontal ? 6 - oldX : oldX;
    const y = transform.vertical ? 6 - oldY : oldY;
    totals[y][x] += stack.length;
  });

  const occupied: Array<[number, number]> = [];
  totals.forEach((row, y) =>
    row.forEach((count, x) => {
      if (count > 0) occupied.push([x, y]);
    }),
  );
  if (!occupied.length) throw new Error("b-center cannot encode an empty board");
  const xs = occupied.map(([x]) => x);
  const ys = occupied.map(([, y]) => y);
  const leftEdge = Math.max(...xs);
  const anchorIndex = Math.max(...ys);
  const frameX = leftEdge - 2;
  const frameY = anchorIndex - 2;
  const anchorRank = anchorIndex + 1;
  const leftMargin = BOARD_SIZE - 1 - leftEdge;
  const topMargin = BOARD_SIZE - 1 - anchorIndex;
  if (anchorRank < 4 || anchorRank > 7) {
    throw new Error(`b-center anchor rank outside 4..7: ${anchorRank}`);
  }
  if (leftMargin < 0 || leftMargin > 3 || topMargin < 0 || topMargin > 3) {
    throw new Error(`b-center margin outside 0..3: ${leftMargin}, ${topMargin}`);
  }
  if (frameX < 0 || frameY < 0 || Math.min(...xs) < frameX || Math.min(...ys) < frameY) {
    throw new Error("b-center board does not fit the 3x3 frame");
  }

  const board = new Float32Array(BOARD_CENTERED_BOARD_SIZE * BOARD_CENTERED_BOARD_SIZE);
  for (let y = 0; y < BOARD_CENTERED_BOARD_SIZE; y += 1) {
    for (let x = 0; x < BOARD_CENTERED_BOARD_SIZE; x += 1) {
      const count = totals[frameY + (2 - y)][frameX + (2 - x)];
      if (count < 0 || count > 2) {
        throw new Error(`b-center cell count outside 0/1/2: ${count}`);
      }
      board[y * BOARD_CENTERED_BOARD_SIZE + x] = count;
    }
  }
  const columnEmptyState =
    (board[1] === 0 && board[4] === 0 && board[7] === 0 ? 1 : 0) |
    (board[2] === 0 && board[5] === 0 && board[8] === 0 ? 2 : 0);
  const rowEmptyState =
    (board[3] === 0 && board[4] === 0 && board[5] === 0 ? 1 : 0) |
    (board[6] === 0 && board[7] === 0 && board[8] === 0 ? 2 : 0);

  const values: number[] = [];
  values.push(
    ...oneHot(anchorRank - 4, 4),
    ...oneHot(leftMargin, 4),
    ...oneHot(topMargin, 4),
    ...oneHot(columnEmptyState, 4),
    ...oneHot(rowEmptyState, 4),
  );
  const hand = state.players[viewer].hand
    .map((card) => [
      transform.mapping[COLORS.indexOf(card.color)],
      transform.vertical ? 6 - card.rankIndex : card.rankIndex,
    ])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  for (let slot = 0; slot < HAND_SIZE; slot += 1) {
    const card = hand[slot];
    values.push(
      ...(card
        ? [1, ...oneHot(card[0], 4), ...rankDeltaOneHot(card[1] - anchorIndex)]
        : Array.from({ length: 1 + 4 + RANK_DELTA_CLASSES }, () => 0)),
    );
  }
  for (let offset = 0; offset < 4; offset += 1) {
    const player = state.players[(viewer + offset) % 4];
    values.push(player.lossScore / 35, player.hand.length / 6, player.negativeCards.length / 56);
  }
  values.push(
    ...oneHot((state.currentPlayerIndex - viewer + 4) % 4, 4),
    ...oneHot(["play", "refill", "game_over"].indexOf(state.phase), 3),
    state.cardsPlayedThisTurn / 2,
    state.settlementCount / 10,
  );
  values.push(...Array.from({ length: HISTORY_SIZE * (1 + 4 + 4 + RANK_DELTA_CLASSES + 2) }, () => 0));
  if (values.length !== BOARD_CENTERED_CONTEXT_SIZE) {
    throw new Error(`b-center context size mismatch: ${values.length}`);
  }
  return { board, context: Float32Array.from(values) };
};

export const encodeCandidatesBoardCenteredNone = (
  candidates: TurnCandidate[],
  viewer: number,
  turnStart: GameState,
  history: RecentPlacement[],
): { board: Float32Array; context: Float32Array } => {
  const boards = new Float32Array(
    candidates.length *
      BOARD_CENTERED_BOARD_CHANNELS *
      BOARD_CENTERED_BOARD_SIZE *
      BOARD_CENTERED_BOARD_SIZE,
  );
  const contexts = new Float32Array(candidates.length * BOARD_CENTERED_CONTEXT_SIZE);
  candidates.forEach((candidate, index) => {
    const evaluationState = v2EvaluationState(turnStart, candidate.actions).state;
    const encoded = encodeCentered(evaluationState, viewer, history);
    boards.set(encoded.board, index * BOARD_CENTERED_BOARD_SIZE * BOARD_CENTERED_BOARD_SIZE);
    contexts.set(encoded.context, index * BOARD_CENTERED_CONTEXT_SIZE);
  });
  return { board: boards, context: contexts };
};
