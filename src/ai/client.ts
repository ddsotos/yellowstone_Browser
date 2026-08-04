import {
  candidateGroupSignature,
  encodeCandidatesV1AtDecisionBoundary,
  playedCardsSignature,
  TurnCandidate,
  TurnEvaluation,
} from "../game/value";
import { GameState, RecentPlacement } from "../game/types";
import { encodeCandidatesBoardColumnsV1 } from "../game/valueBoardColumns";
import { encodeCandidatesBoardCenteredNone } from "../game/valueBoardCentered";
import { V2TrackingState } from "../game/v2Tracking";

const TIMEOUT_MS = 30_000;
let worker: Worker | null = null;
let requestId = 0;

export const CURRENT_MODEL_ID = "v1-6h-snapshot-board-columns-v1-epoch001";
export type ModelId =
  | "v1-board-centered-explore-none-76919-epoch001"
  | "v1-6h-snapshot-canonical-epoch001"
  | typeof CURRENT_MODEL_ID;
export type ScoreKind = "probability";
type EncoderKind = "v1" | "board_centered_none" | "board_columns_v1";

export interface ModelSpec {
  id: ModelId;
  label: string;
  boardChannels: number;
  boardSize?: number;
  boardHeight?: number;
  boardWidth?: number;
  contextSize: number;
  scoreKind: ScoreKind;
  outputTransform: "sigmoid" | "identity" | "softmax_player0";
  encoder: EncoderKind;
  grouping: "cards" | "cards_refill";
}

export const MODEL_SPECS: readonly ModelSpec[] = [
  {
    id: "v1-board-centered-explore-none-76919-epoch001",
    label: "b-center V1 explore none 76,919 epoch001",
    boardChannels: 1,
    boardSize: 3,
    contextSize: 173,
    scoreKind: "probability",
    outputTransform: "sigmoid",
    encoder: "board_centered_none",
    grouping: "cards",
  },
  {
    id: "v1-6h-snapshot-canonical-epoch001",
    label: "Canonical V1 6h snapshot epoch001",
    boardChannels: 29,
    contextSize: 81,
    scoreKind: "probability",
    outputTransform: "sigmoid",
    encoder: "v1",
    grouping: "cards",
  },
  {
    id: CURRENT_MODEL_ID,
    label: "Board columns V1 6h snapshot epoch001",
    boardChannels: 1,
    boardHeight: 7,
    boardWidth: 3,
    contextSize: 62,
    scoreKind: "probability",
    outputTransform: "sigmoid",
    encoder: "board_columns_v1",
    grouping: "cards",
  },
] as const;

export const PLAYABLE_MODEL_SPECS = MODEL_SPECS;

export interface ModelAnalysis {
  spec: ModelSpec;
  status: "ok" | "error";
  own?: TurnEvaluation;
  top: TurnEvaluation[];
  all: TurnEvaluation[];
  error?: string;
}

const createWorker = (): Worker =>
  new Worker(`${import.meta.env.BASE_URL}ai-worker.js`);

export class AiTimeoutError extends Error {}

const modelUrl = (id: ModelId): string =>
  new URL(
    `${import.meta.env.BASE_URL}models/${id}.onnx`,
    window.location.href,
  ).href;

const activeWorker = (): Worker => {
  worker ??= createWorker();
  return worker;
};

const tensorsFor = (
  spec: ModelSpec,
  candidates: TurnCandidate[],
  viewer: number,
  turnStart: GameState,
  tracking: V2TrackingState,
  history: RecentPlacement[],
) => {
  if (spec.encoder === "v1") {
    return encodeCandidatesV1AtDecisionBoundary(candidates, viewer, turnStart);
  }
  if (spec.encoder === "board_centered_none") {
    return encodeCandidatesBoardCenteredNone(
      candidates,
      viewer,
      turnStart,
      history,
    );
  }
  if (spec.encoder === "board_columns_v1") {
    return encodeCandidatesBoardColumnsV1(candidates, viewer, turnStart, history);
  }
  return encodeCandidatesV1AtDecisionBoundary(candidates, viewer, turnStart);
};

const infer = async (
  spec: ModelSpec,
  candidates: TurnCandidate[],
  viewer: number,
  turnStart: GameState,
  tracking: V2TrackingState,
  history: RecentPlacement[],
): Promise<TurnEvaluation[]> => {
  if (!candidates.length) return [];
  const active = activeWorker();
  const id = ++requestId;
  const { board, context } = tensorsFor(
    spec,
    candidates,
    viewer,
    turnStart,
    tracking,
    history,
  );
  return new Promise<TurnEvaluation[]>((resolve, reject) => {
    const cleanup = () => active.removeEventListener("message", onMessage);
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new AiTimeoutError(`${spec.label} inference exceeded 30 seconds`));
    }, TIMEOUT_MS);
    const onMessage = (
      event: MessageEvent<{ id: number; scores?: ArrayBuffer; error?: string }>,
    ) => {
      if (event.data.id !== id) return;
      window.clearTimeout(timeout);
      cleanup();
      if (event.data.error || !event.data.scores) {
        reject(new Error(event.data.error ?? `${spec.label} inference failed`));
        return;
      }
      const scores = new Float32Array(event.data.scores);
      resolve(
        candidates.map((candidate, index) => ({
          candidate,
          probability: scores[index],
        })),
      );
    };
    active.addEventListener("message", onMessage);
    active.postMessage(
      {
        type: "infer",
        id,
        modelUrl: modelUrl(spec.id),
        count: candidates.length,
        boardChannels: spec.boardChannels,
        boardSize: spec.boardSize ?? 7,
        boardHeight: spec.boardHeight ?? spec.boardSize ?? 7,
        boardWidth: spec.boardWidth ?? spec.boardSize ?? 7,
        contextSize: spec.contextSize,
        outputTransform: spec.outputTransform,
        board: board.buffer,
        context: context.buffer,
      },
      [board.buffer, context.buffer],
    );
  });
};

const topFor = (
  spec: ModelSpec,
  turnStart: GameState,
  evaluations: TurnEvaluation[],
  limit = 3,
): TurnEvaluation[] => {
  const groups = new Map<string, TurnEvaluation>();
  evaluations.forEach((evaluation) => {
    const signature =
      spec.grouping === "cards_refill"
        ? candidateGroupSignature(turnStart, evaluation.candidate.actions)
        : playedCardsSignature(turnStart, evaluation.candidate.actions);
    const previous = groups.get(signature);
    if (!previous || evaluation.probability > previous.probability) {
      groups.set(signature, evaluation);
    }
  });
  return [...groups.entries()]
    .sort(
      ([leftKey, left], [rightKey, right]) =>
        right.probability - left.probability ||
        leftKey.localeCompare(rightKey),
    )
    .slice(0, limit)
    .map(([, evaluation]) => evaluation);
};

export const evaluateAllModels = async (
  candidates: TurnCandidate[],
  ownCandidate: TurnCandidate,
  viewer: number,
  turnStart: GameState,
  tracking: V2TrackingState,
  history: RecentPlacement[],
  modelIds: readonly ModelId[] = MODEL_SPECS.map((spec) => spec.id),
): Promise<ModelAnalysis[]> => {
  const results: ModelAnalysis[] = [];
  for (const spec of MODEL_SPECS.filter((value) => modelIds.includes(value.id))) {
    try {
      const evaluatedCandidates = [...candidates, ownCandidate];
      const evaluations =
        await infer(spec, evaluatedCandidates, viewer, turnStart, tracking, history);
      const own = evaluations.at(-1);
      if (!own) throw new Error("own move could not be evaluated");
      const all = evaluations.slice(0, -1);
      results.push({
        spec,
        status: "ok",
        own,
        top: topFor(spec, turnStart, all),
        all,
      });
    } catch (error) {
      results.push({
        spec,
        status: "error",
        top: [],
        all: [],
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
};

const DEFAULT_PLAY_MODEL = PLAYABLE_MODEL_SPECS[0];

export const warmAi = (modelId: ModelId = DEFAULT_PLAY_MODEL.id): void => {
  const active = activeWorker();
  const spec = MODEL_SPECS.find((value) => value.id === modelId) ?? DEFAULT_PLAY_MODEL;
  active.postMessage({
    type: "init",
    id: ++requestId,
    modelUrl: modelUrl(spec.id),
  });
};

export const evaluateCandidates = (
  candidates: TurnCandidate[],
  viewer: number,
  turnStart: GameState,
  tracking: V2TrackingState,
  history: RecentPlacement[] = [],
  modelId: ModelId = DEFAULT_PLAY_MODEL.id,
): Promise<TurnEvaluation[]> =>
  infer(
    MODEL_SPECS.find((spec) => spec.id === modelId) ?? DEFAULT_PLAY_MODEL,
    candidates,
    viewer,
    turnStart,
    tracking,
    history,
  );

export const selectBestTurn = async (
  candidates: TurnCandidate[],
  viewer: number,
  turnStart: GameState,
  tracking: V2TrackingState,
  history: RecentPlacement[] = [],
  modelId: ModelId = DEFAULT_PLAY_MODEL.id,
): Promise<TurnEvaluation> => {
  const evaluations = await evaluateCandidates(
    candidates,
    viewer,
    turnStart,
    tracking,
    history,
    modelId,
  );
  if (!evaluations.length) throw new Error("no candidate moves can be evaluated");
  return evaluations.reduce((best, current) =>
    current.probability > best.probability ? current : best,
  );
};
