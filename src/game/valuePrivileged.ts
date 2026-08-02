import { sortHand } from "./game";
import { BOARD_SIZE, COLORS, FRAME_SIZE, GameState, RecentPlacement } from "./types";

export const PRIVILEGED_BOARD_CHANNELS = 29;
export const PRIVILEGED_CONTEXT_SIZE = 190;
export const PRIVILEGED_SAFE_COUNTS_CONTEXT_SIZE = 199;

const rankFractions = (cards: { rankIndex: number }[]): number[] => {
  if (!cards.length) return [0, 0, 0];
  return [
    cards.filter((card) => card.rankIndex <= 1).length / cards.length,
    cards.filter((card) => card.rankIndex >= 2 && card.rankIndex <= 4).length /
      cards.length,
    cards.filter((card) => card.rankIndex >= 5).length / cards.length,
  ];
};

const oneHot = (index: number, size: number): number[] =>
  Array.from({ length: size }, (_, value) => (value === index ? 1 : 0));

const colorIndex = (color: string): number => COLORS.indexOf(color as (typeof COLORS)[number]);

const rankOffsetSets = (state: GameState): { safe: Set<number>; oneOff: Set<number> } => {
  const ranks = new Set<number>();
  Object.values(state.board).forEach((stack) =>
    stack.forEach((card) => ranks.add(card.rankIndex)),
  );
  const safe = new Set<number>();
  if (!ranks.size) {
    for (let rank = 0; rank < BOARD_SIZE; rank += 1) safe.add(rank);
  } else {
    for (let start = 0; start <= BOARD_SIZE - FRAME_SIZE; start += 1) {
      const window = new Set(
        Array.from({ length: FRAME_SIZE }, (_, offset) => start + offset),
      );
      if ([...ranks].every((rank) => window.has(rank))) {
        window.forEach((rank) => safe.add(rank));
      }
    }
  }
  const oneOff = new Set<number>();
  safe.forEach((rank) => {
    [rank - 1, rank + 1].forEach((candidate) => {
      if (candidate >= 0 && candidate < BOARD_SIZE && !safe.has(candidate)) {
        oneOff.add(candidate);
      }
    });
  });
  return { safe, oneOff };
};

const safeAndOneOffCounts = (state: GameState): Array<[number, number]> => {
  const { safe, oneOff } = rankOffsetSets(state);
  const boardColors = new Set(
    Object.values(state.board).flatMap((stack) => stack.map((card) => card.color)),
  );
  const colorOffset = (color: string) =>
    boardColors.has(color as (typeof COLORS)[number]) || boardColors.size <= 2 ? 0 : 1;
  return state.players.map((player) => {
    let safeCount = 0;
    let oneOffCount = 0;
    player.hand.forEach((card) => {
      const rankOffset = safe.has(card.rankIndex) ? 0 : oneOff.has(card.rankIndex) ? 1 : 2;
      const offset = rankOffset + colorOffset(card.color);
      if (offset === 0) safeCount += 1;
      else if (offset === 1) oneOffCount += 1;
    });
    return [safeCount, oneOffCount];
  });
};

const boardCardCount = (state: GameState): number =>
  Object.values(state.board).reduce((count, stack) => count + stack.length, 0);

const encodePrivilegedCandidatesWithOptions = (
  state: GameState,
  history: RecentPlacement[],
  candidates: number,
  includeSafeCounts: boolean,
  viewer?: number,
): { board: Float32Array; context: Float32Array } => {
  const contextSize = includeSafeCounts
    ? PRIVILEGED_SAFE_COUNTS_CONTEXT_SIZE
    : PRIVILEGED_CONTEXT_SIZE;
  const board = new Float32Array(candidates * PRIVILEGED_BOARD_CHANNELS * 49);
  const context = new Float32Array(candidates * contextSize);
  const current = viewer ?? state.currentPlayerIndex;
  const counts = includeSafeCounts ? safeAndOneOffCounts(state) : [];
  Object.entries(state.board).forEach(([key, stack]) => {
    const [x, y] = key.split(",").map(Number);
    stack.forEach((card) => {
      const offset = card.color === undefined ? 0 : colorIndex(card.color) * 7 + card.rankIndex;
      for (let batch = 0; batch < candidates; batch++) {
        board[batch * PRIVILEGED_BOARD_CHANNELS * 49 + offset * 49 + y * 7 + x] += 1;
        board[batch * PRIVILEGED_BOARD_CHANNELS * 49 + 28 * 49 + y * 7 + x] += 1;
      }
    });
  });
  const values: number[] = [];
  for (let offset = 0; offset < 4; offset++) {
    const player = state.players[(current + offset) % 4];
    for (const card of sortHand(player.hand)) {
      values.push(1, ...oneHot(colorIndex(card.color), 4), card.rankIndex / 6);
    }
    for (let slot = player.hand.length; slot < 6; slot++) values.push(0, 0, 0, 0, 0, 0);
    values.push(
      player.lossScore / 35,
      player.negativeCards.length / 56,
      ...rankFractions(player.negativeCards),
    );
    if (includeSafeCounts) {
      const [safeCount, oneOffCount] = counts[(current + offset) % 4];
      values.push(safeCount / 6, oneOffCount / 6);
    }
  }
  values.push(state.deck.length / 112, state.settlementCount / 10);
  if (includeSafeCounts) values.push(boardCardCount(state) / 49);
  const recent = history.slice(-2);
  for (let i = 0; i < 2 - recent.length; i++) values.push(...Array(12).fill(0));
  for (const placement of recent) {
    values.push(
      1,
      ...oneHot((placement.playerIndex - current + 4) % 4, 4),
      ...oneHot(colorIndex(placement.card.color), 4),
      placement.card.rankIndex / 6,
      placement.scoreDelta / 3,
      placement.negativeCardDelta / 9,
    );
  }
  if (values.length !== contextSize) {
    throw new Error(`unexpected privileged context size: ${values.length}`);
  }
  for (let batch = 0; batch < candidates; batch++) {
    context.set(values, batch * contextSize);
  }
  return { board, context };
};

export const encodePrivilegedCandidates = (
  state: GameState,
  history: RecentPlacement[],
  candidates: number,
): { board: Float32Array; context: Float32Array } =>
  encodePrivilegedCandidatesWithOptions(state, history, candidates, false);

export const encodePrivilegedSafeCountCandidates = (
  state: GameState,
  history: RecentPlacement[],
  candidates: number,
): { board: Float32Array; context: Float32Array } =>
  encodePrivilegedCandidatesWithOptions(state, history, candidates, true);

export interface PrivilegedSafeCountStateInput {
  state: GameState;
  history: RecentPlacement[];
  viewer?: number;
}

export const encodePrivilegedSafeCountStateInputs = (
  inputs: PrivilegedSafeCountStateInput[],
): { board: Float32Array; context: Float32Array } => {
  const board = new Float32Array(
    inputs.length * PRIVILEGED_BOARD_CHANNELS * BOARD_SIZE * BOARD_SIZE,
  );
  const context = new Float32Array(
    inputs.length * PRIVILEGED_SAFE_COUNTS_CONTEXT_SIZE,
  );
  inputs.forEach((input, index) => {
    const encoded = encodePrivilegedCandidatesWithOptions(
      input.state,
      input.history,
      1,
      true,
      input.viewer,
    );
    board.set(encoded.board, index * PRIVILEGED_BOARD_CHANNELS * BOARD_SIZE * BOARD_SIZE);
    context.set(encoded.context, index * PRIVILEGED_SAFE_COUNTS_CONTEXT_SIZE);
  });
  return { board, context };
};
