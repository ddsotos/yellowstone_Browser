import { sortHand } from "./game";
import { COLORS, GameState, RecentPlacement } from "./types";

export const PRIVILEGED_BOARD_CHANNELS = 29;
export const PRIVILEGED_CONTEXT_SIZE = 190;

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

export const encodePrivilegedCandidates = (
  state: GameState,
  history: RecentPlacement[],
  candidates: number,
): { board: Float32Array; context: Float32Array } => {
  const board = new Float32Array(candidates * PRIVILEGED_BOARD_CHANNELS * 49);
  const context = new Float32Array(candidates * PRIVILEGED_CONTEXT_SIZE);
  const current = state.currentPlayerIndex;
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
  }
  values.push(state.deck.length / 112, state.settlementCount / 10);
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
  if (values.length !== PRIVILEGED_CONTEXT_SIZE) {
    throw new Error(`unexpected privileged context size: ${values.length}`);
  }
  for (let batch = 0; batch < candidates; batch++) {
    context.set(values, batch * PRIVILEGED_CONTEXT_SIZE);
  }
  return { board, context };
};
