import { GameState, RecentPlacement } from "./types";
import {
  BOARD_CHANNELS,
  CONTEXT_SIZE,
  encodeCandidatesV1AtDecisionBoundary,
  TurnCandidate,
} from "./value";
import {
  canonicalRecordV2Lite,
  VALUE_CONTEXT_SIZE_V2_LITE,
} from "./valueV2Lite";
import { V2TrackingState } from "./v2Tracking";

export const BOARD_COLUMNS_V1_CHANNELS = 1;
export const BOARD_COLUMNS_V1_HEIGHT = 7;
export const BOARD_COLUMNS_V1_WIDTH = 3;
export const BOARD_COLUMNS_V1_LEFT_MARGIN_CLASSES = 5;
export const BOARD_COLUMNS_V1_CONTEXT_SIZE =
  CONTEXT_SIZE - 2 * 12 + BOARD_COLUMNS_V1_LEFT_MARGIN_CLASSES;
export const PREPLAY_BOARD_COLUMNS_CONTEXT_SIZE = VALUE_CONTEXT_SIZE_V2_LITE + 7;

const SOURCE_BOARD_RECORD_SIZE = BOARD_CHANNELS * 7 * 7;
const COMPACT_BOARD_RECORD_SIZE =
  BOARD_COLUMNS_V1_CHANNELS * BOARD_COLUMNS_V1_HEIGHT * BOARD_COLUMNS_V1_WIDTH;

const sourceBoardIndex = (
  record: number,
  channel: number,
  y: number,
  x: number,
): number => record * SOURCE_BOARD_RECORD_SIZE + (channel * 7 + y) * 7 + x;

const compactBoardIndex = (
  record: number,
  y: number,
  x: number,
): number => record * COMPACT_BOARD_RECORD_SIZE + y * BOARD_COLUMNS_V1_WIDTH + x;

const compactContextIndex = (record: number, offset: number): number =>
  record * BOARD_COLUMNS_V1_CONTEXT_SIZE + offset;

export const boardColumnsFromCanonicalV1Tensors = (
  sourceBoard: Float32Array,
  sourceContext: Float32Array,
): { board: Float32Array; context: Float32Array } => {
  if (sourceBoard.length % SOURCE_BOARD_RECORD_SIZE !== 0) {
    throw new Error(`board_columns_v1 board size mismatch: ${sourceBoard.length}`);
  }
  const records = sourceBoard.length / SOURCE_BOARD_RECORD_SIZE;
  if (sourceContext.length !== records * CONTEXT_SIZE) {
    throw new Error(
      `board_columns_v1 context size mismatch: ${sourceContext.length}`,
    );
  }

  const board = new Float32Array(records * COMPACT_BOARD_RECORD_SIZE);
  const context = new Float32Array(records * BOARD_COLUMNS_V1_CONTEXT_SIZE);
  const keptContext = CONTEXT_SIZE - 2 * 12;
  for (let record = 0; record < records; record += 1) {
    context.set(
      sourceContext.slice(
        record * CONTEXT_SIZE,
        record * CONTEXT_SIZE + keptContext,
      ),
      record * BOARD_COLUMNS_V1_CONTEXT_SIZE,
    );

    let left = 7;
    let right = -1;
    for (let x = 0; x < 7; x += 1) {
      let count = 0;
      for (let y = 0; y < 7; y += 1) {
        count += sourceBoard[sourceBoardIndex(record, 28, y, x)];
      }
      if (count > 0) {
        left = Math.min(left, x);
        right = Math.max(right, x);
      }
    }
    if (right < left) throw new Error("board_columns_v1 cannot encode an empty board");
    const width = right - left + 1;
    if (width > BOARD_COLUMNS_V1_WIDTH) {
      throw new Error(`board_columns_v1 occupied width exceeds 3: ${width}`);
    }
    if (left < 0 || left >= BOARD_COLUMNS_V1_LEFT_MARGIN_CLASSES) {
      throw new Error(`board_columns_v1 left margin out of range: ${left}`);
    }
    for (let y = 0; y < BOARD_COLUMNS_V1_HEIGHT; y += 1) {
      for (let x = 0; x < width; x += 1) {
        board[compactBoardIndex(record, y, x)] =
          sourceBoard[sourceBoardIndex(record, 28, y, left + x)];
      }
    }
    context[
      compactContextIndex(
        record,
        BOARD_COLUMNS_V1_CONTEXT_SIZE -
          BOARD_COLUMNS_V1_LEFT_MARGIN_CLASSES +
          left,
      )
    ] = 1;
  }
  return { board, context };
};

export const boardColumnsFromCanonicalV2LitePreplay = (
  sourceBoard: Float32Array,
  sourceContext: Float32Array,
): { board: Float32Array; context: Float32Array } => {
  const sourceRecordSize = 29 * 7 * 7;
  if (sourceBoard.length % sourceRecordSize !== 0) {
    throw new Error(`preplay_board_columns board size mismatch: ${sourceBoard.length}`);
  }
  const records = sourceBoard.length / sourceRecordSize;
  if (sourceContext.length !== records * VALUE_CONTEXT_SIZE_V2_LITE) {
    throw new Error(
      `preplay_board_columns context size mismatch: ${sourceContext.length}`,
    );
  }
  const board = new Float32Array(records * COMPACT_BOARD_RECORD_SIZE);
  const context = new Float32Array(records * PREPLAY_BOARD_COLUMNS_CONTEXT_SIZE);
  for (let record = 0; record < records; record += 1) {
    context.set(
      sourceContext.slice(
        record * VALUE_CONTEXT_SIZE_V2_LITE,
        (record + 1) * VALUE_CONTEXT_SIZE_V2_LITE,
      ),
      record * PREPLAY_BOARD_COLUMNS_CONTEXT_SIZE,
    );
    let left = 7;
    let right = -1;
    for (let x = 0; x < 7; x += 1) {
      let count = 0;
      for (let y = 0; y < 7; y += 1) {
        count += sourceBoard[record * sourceRecordSize + 28 * 49 + y * 7 + x];
      }
      if (count > 0) {
        left = Math.min(left, x);
        right = Math.max(right, x);
      }
    }
    if (right < left) throw new Error("preplay_board_columns cannot encode an empty board");
    const width = right - left + 1;
    if (width > BOARD_COLUMNS_V1_WIDTH) {
      throw new Error(`preplay_board_columns occupied width exceeds 3: ${width}`);
    }
    for (let y = 0; y < BOARD_COLUMNS_V1_HEIGHT; y += 1) {
      for (let x = 0; x < width; x += 1) {
        board[compactBoardIndex(record, y, x)] =
          sourceBoard[record * sourceRecordSize + 28 * 49 + y * 7 + left + x];
      }
    }
    context[record * PREPLAY_BOARD_COLUMNS_CONTEXT_SIZE + VALUE_CONTEXT_SIZE_V2_LITE + left] = 1;
  }
  return { board, context };
};

export const encodeCandidatesBoardColumnsV1 = (
  candidates: TurnCandidate[],
  viewer: number,
  turnStart: GameState,
  _history: RecentPlacement[] = [],
): { board: Float32Array; context: Float32Array } => {
  const canonical = encodeCandidatesV1AtDecisionBoundary(
    candidates,
    viewer,
    turnStart,
  );
  return boardColumnsFromCanonicalV1Tensors(canonical.board, canonical.context);
};

export const encodePreplayBoardColumnsState = (
  viewer: number,
  turnStart: GameState,
  tracking: V2TrackingState,
): { board: Float32Array; context: Float32Array } => {
  const value = canonicalRecordV2Lite({
    before: turnStart,
    after: turnStart,
    viewer,
    history: tracking.history.slice(-2),
    pending: "no_pending",
  });
  return boardColumnsFromCanonicalV2LitePreplay(
    value.board.slice(0, 29 * 49),
    value.context,
  );
};
