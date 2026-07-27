export const VALUE_CANONICALIZATION = "fast_lr_ud_color_v1";

const BOARD_SIZE = 7;
const COLOR_COUNT = 4;
const COLOR_RANK_CHANNELS = 28;
const BOARD_CHANNELS = 29;
const BOARD_RECORD_SIZE = BOARD_CHANNELS * BOARD_SIZE * BOARD_SIZE;
const HAND_SIZE = 6;
const HAND_FEATURES = 6;
const HISTORY_SIZE = 2;
const HISTORY_OFFSET = HAND_SIZE * HAND_FEATURES + 12 + 9;
const HISTORY_FEATURES = 12;
const CONTEXT_SIZE = 81;
const CANONICAL_COLOR_SEQUENCE = [1, 0, 2, 3] as const;
const COLOR_SORT_PRIORITY = [2, 0, 1, 3] as const;
const RANK_WEIGHTS = [117649, 16807, 2401, 343, 49, 7, 1] as const;
const MAX_HAND_SIGNATURE = 6 * RANK_WEIGHTS[0];

const boardIndex = (
  record: number,
  channel: number,
  y: number,
  x: number,
): number =>
  record * BOARD_RECORD_SIZE +
  ((channel * BOARD_SIZE + y) * BOARD_SIZE + x);

const contextIndex = (record: number, offset: number): number =>
  record * CONTEXT_SIZE + offset;

const argmax = (values: number[]): number => {
  let best = 0;
  for (let index = 1; index < values.length; index += 1) {
    if (values[index] > values[best]) best = index;
  }
  return best;
};

/**
 * Exact browser port of online_bundle.value_canonicalization:
 * fast_lr_ud_color_v1.
 */
export const canonicalizeValueTensors = (
  sourceBoard: Float32Array,
  sourceContext: Float32Array,
): { board: Float32Array; context: Float32Array } => {
  if (sourceBoard.length % BOARD_RECORD_SIZE !== 0) {
    throw new Error(`正規化前の盤面サイズが不正です: ${sourceBoard.length}`);
  }
  const recordCount = sourceBoard.length / BOARD_RECORD_SIZE;
  if (sourceContext.length !== recordCount * CONTEXT_SIZE) {
    throw new Error(`正規化前のコンテキストサイズが不正です: ${sourceContext.length}`);
  }
  const board = new Float32Array(sourceBoard);
  const context = new Float32Array(sourceContext);

  for (let record = 0; record < recordCount; record += 1) {
    let rightCount = 0;
    let leftCount = 0;
    for (let y = 0; y < BOARD_SIZE; y += 1) {
      for (let x = 0; x < 3; x += 1) {
        rightCount += board[boardIndex(record, 28, y, x)];
      }
      for (let x = 4; x < BOARD_SIZE; x += 1) {
        leftCount += board[boardIndex(record, 28, y, x)];
      }
    }
    if (leftCount > rightCount) {
      for (let channel = 0; channel < BOARD_CHANNELS; channel += 1) {
        for (let y = 0; y < BOARD_SIZE; y += 1) {
          for (let x = 0; x < 3; x += 1) {
            const opposite = 6 - x;
            const left = boardIndex(record, channel, y, x);
            const right = boardIndex(record, channel, y, opposite);
            [board[left], board[right]] = [board[right], board[left]];
          }
        }
      }
    }

    let lowRankCount = 0;
    let highRankCount = 0;
    for (let y = 0; y < 3; y += 1) {
      for (let x = 0; x < BOARD_SIZE; x += 1) {
        lowRankCount += board[boardIndex(record, 28, y, x)];
        highRankCount += board[boardIndex(record, 28, 6 - y, x)];
      }
    }
    if (highRankCount > lowRankCount) {
      const original = board.slice(
        record * BOARD_RECORD_SIZE,
        (record + 1) * BOARD_RECORD_SIZE,
      );
      const originalIndex = (channel: number, y: number, x: number): number =>
        (channel * BOARD_SIZE + y) * BOARD_SIZE + x;
      for (let color = 0; color < COLOR_COUNT; color += 1) {
        for (let rank = 0; rank < BOARD_SIZE; rank += 1) {
          for (let y = 0; y < BOARD_SIZE; y += 1) {
            for (let x = 0; x < BOARD_SIZE; x += 1) {
              board[boardIndex(record, color * 7 + rank, y, x)] =
                original[originalIndex(color * 7 + (6 - rank), 6 - y, x)];
            }
          }
        }
      }
      for (let y = 0; y < BOARD_SIZE; y += 1) {
        for (let x = 0; x < BOARD_SIZE; x += 1) {
          board[boardIndex(record, 28, y, x)] =
            original[originalIndex(28, 6 - y, x)];
        }
      }
      for (let slot = 0; slot < HAND_SIZE; slot += 1) {
        const offset = slot * HAND_FEATURES;
        if (context[contextIndex(record, offset)] > 0.5) {
          const rank = Math.round(
            context[contextIndex(record, offset + 5)] * 6,
          );
          context[contextIndex(record, offset + 5)] = (6 - rank) / 6;
        }
      }
      for (let index = 0; index < HISTORY_SIZE; index += 1) {
        const offset = HISTORY_OFFSET + index * HISTORY_FEATURES;
        if (context[contextIndex(record, offset)] > 0.5) {
          const rank = Math.round(
            context[contextIndex(record, offset + 9)] * 6,
          );
          context[contextIndex(record, offset + 9)] = (6 - rank) / 6;
        }
      }
    }

    const present: boolean[] = [];
    const columns: number[] = [];
    for (let color = 0; color < COLOR_COUNT; color += 1) {
      const sums = Array.from({ length: BOARD_SIZE }, () => 0);
      for (let rank = 0; rank < BOARD_SIZE; rank += 1) {
        for (let y = 0; y < BOARD_SIZE; y += 1) {
          for (let x = 0; x < BOARD_SIZE; x += 1) {
            sums[x] += board[boardIndex(record, color * 7 + rank, y, x)];
          }
        }
      }
      present[color] = sums.some((value) => value > 0);
      columns[color] = argmax(sums);
    }

    const handColors: number[] = [];
    const handRanks: number[] = [];
    const handPresent: boolean[] = [];
    const handCounts = Array.from({ length: COLOR_COUNT }, () =>
      Array.from({ length: BOARD_SIZE }, () => 0),
    );
    for (let slot = 0; slot < HAND_SIZE; slot += 1) {
      const offset = slot * HAND_FEATURES;
      handPresent[slot] = context[contextIndex(record, offset)] > 0.5;
      handColors[slot] = argmax(
        Array.from(
          { length: COLOR_COUNT },
          (_, color) => context[contextIndex(record, offset + 1 + color)],
        ),
      );
      handRanks[slot] = Math.round(
        context[contextIndex(record, offset + 5)] * 6,
      );
      if (handPresent[slot]) {
        handCounts[handColors[slot]][handRanks[slot]] += 1;
      }
    }
    const handSignatures = handCounts.map((counts) =>
      counts.reduce(
        (sum, count, rank) => sum + count * RANK_WEIGHTS[rank],
        0,
      ),
    );
    const orderedOldColors = [0, 1, 2, 3].sort((left, right) => {
      const leftKey = present[left]
        ? 6 - columns[left]
        : 1_000_000 +
          (MAX_HAND_SIGNATURE - handSignatures[left]) * COLOR_COUNT +
          left;
      const rightKey = present[right]
        ? 6 - columns[right]
        : 1_000_000 +
          (MAX_HAND_SIGNATURE - handSignatures[right]) * COLOR_COUNT +
          right;
      return leftKey - rightKey;
    });
    const oldToNew = Array.from({ length: COLOR_COUNT }, () => 0);
    orderedOldColors.forEach((oldColor, index) => {
      oldToNew[oldColor] = CANONICAL_COLOR_SEQUENCE[index];
    });

    const originalColors = board.slice(
      record * BOARD_RECORD_SIZE,
      record * BOARD_RECORD_SIZE + COLOR_RANK_CHANNELS * 49,
    );
    const originalColorIndex = (
      channel: number,
      y: number,
      x: number,
    ): number => (channel * BOARD_SIZE + y) * BOARD_SIZE + x;
    for (let oldColor = 0; oldColor < COLOR_COUNT; oldColor += 1) {
      const newColor = oldToNew[oldColor];
      for (let rank = 0; rank < BOARD_SIZE; rank += 1) {
        for (let y = 0; y < BOARD_SIZE; y += 1) {
          for (let x = 0; x < BOARD_SIZE; x += 1) {
            board[boardIndex(record, newColor * 7 + rank, y, x)] =
              originalColors[
                originalColorIndex(oldColor * 7 + rank, y, x)
              ];
          }
        }
      }
    }

    const originalHand = context.slice(
      record * CONTEXT_SIZE,
      record * CONTEXT_SIZE + HAND_SIZE * HAND_FEATURES,
    );
    const handOrder = Array.from({ length: HAND_SIZE }, (_, slot) => slot).sort(
      (left, right) => {
        const key = (slot: number) =>
          handPresent[slot]
            ? handRanks[slot] * COLOR_COUNT +
              COLOR_SORT_PRIORITY[oldToNew[handColors[slot]]]
            : 10_000;
        return key(left) - key(right);
      },
    );
    handOrder.forEach((oldSlot, newSlot) => {
      const target = newSlot * HAND_FEATURES;
      const source = oldSlot * HAND_FEATURES;
      context[contextIndex(record, target)] = originalHand[source];
      for (let color = 0; color < COLOR_COUNT; color += 1) {
        context[contextIndex(record, target + 1 + color)] = 0;
      }
      if (handPresent[oldSlot]) {
        context[
          contextIndex(record, target + 1 + oldToNew[handColors[oldSlot]])
        ] = 1;
      }
      context[contextIndex(record, target + 5)] =
        originalHand[source + 5];
    });

    for (let index = 0; index < HISTORY_SIZE; index += 1) {
      const offset = HISTORY_OFFSET + index * HISTORY_FEATURES;
      const isPresent = context[contextIndex(record, offset)] > 0.5;
      const oldColor = argmax(
        Array.from(
          { length: COLOR_COUNT },
          (_, color) => context[contextIndex(record, offset + 5 + color)],
        ),
      );
      for (let color = 0; color < COLOR_COUNT; color += 1) {
        context[contextIndex(record, offset + 5 + color)] = 0;
      }
      if (isPresent) {
        context[
          contextIndex(record, offset + 5 + oldToNew[oldColor])
        ] = 1;
      }
    }
  }
  return { board, context };
};
