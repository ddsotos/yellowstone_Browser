import {
  candidateGroupSignature,
  encodeCandidatesV1AtDecisionBoundary,
  playedCardsSignature,
  TurnCandidate,
  TurnEvaluation,
} from "../game/value";
import { GameState, RecentPlacement } from "../game/types";
import { encodeCandidatesV2 } from "../game/valueV2";
import {
  encodeCandidatesActionDelta,
  encodeCandidatesV2Lite,
} from "../game/valueV2Lite";
import { encodeCandidatesBoardCenteredNone } from "../game/valueBoardCentered";
import { V2TrackingState } from "../game/v2Tracking";
import { encodePrivilegedCandidates } from "../game/valuePrivileged";

const TIMEOUT_MS = 30_000;
let worker: Worker | null = null;
let requestId = 0;

export type ModelId =
  | "preplay-v1-current"
  | "v1-generation0-epoch002"
  | "v2-generation0-epoch001"
  | "action-delta-selected"
  | "v1-new-88966-epoch001"
  | "v1-exploratory-59826-epoch001"
  | "v1-board-centered-explore-none-76919-epoch001";
export type ScoreKind = "probability" | "delta";
type EncoderKind =
  | "v1"
  | "v2"
  | "v2_lite"
  | "action_delta"
  | "privileged"
  | "board_centered_none";

export interface ModelSpec {
  id: ModelId;
  label: string;
  boardChannels: number;
  boardSize?: number;
  contextSize: number;
  scoreKind: ScoreKind;
  outputTransform: "sigmoid" | "identity" | "softmax_player0";
  encoder: EncoderKind;
  grouping: "cards" | "cards_refill";
}

export const MODEL_SPECS: readonly ModelSpec[] = [
  {
    id: "preplay-v1-current",
    label: "Pre-play V1 current（privileged preview）",
    boardChannels: 29,
    contextSize: 190,
    scoreKind: "probability",
    outputTransform: "identity",
    encoder: "privileged",
    grouping: "cards",
  },
  {
    id: "v1-generation0-epoch002",
    label: "Original V1 gen0 epoch002",
    boardChannels: 29,
    contextSize: 81,
    scoreKind: "probability",
    outputTransform: "sigmoid",
    encoder: "v1",
    grouping: "cards",
  },
  {
    id: "v2-generation0-epoch001",
    label: "V2 gen0 epoch001",
    boardChannels: 29,
    contextSize: 300,
    scoreKind: "probability",
    outputTransform: "sigmoid",
    encoder: "v2",
    grouping: "cards_refill",
  },
  {
    id: "action-delta-selected",
    label: "Action delta（公開情報）",
    boardChannels: 58,
    contextSize: 150,
    scoreKind: "delta",
    outputTransform: "identity",
    encoder: "action_delta",
    grouping: "cards",
  },
  {
    id: "v1-new-88966-epoch001",
    label: "Original V1 新88,966戦 epoch001",
    boardChannels: 29,
    contextSize: 81,
    scoreKind: "probability",
    outputTransform: "sigmoid",
    encoder: "v1",
    grouping: "cards",
  },
  {
    id: "v1-exploratory-59826-epoch001",
    label: "V1 explore 59,826戦 epoch001",
    boardChannels: 29,
    contextSize: 81,
    scoreKind: "probability",
    outputTransform: "sigmoid",
    encoder: "v1",
    grouping: "cards",
  },
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
] as const;

export const PLAYABLE_MODEL_SPECS = MODEL_SPECS.filter(
  (spec) => spec.id !== "preplay-v1-current",
);

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
  if (spec.encoder === "v2") {
    return encodeCandidatesV2(candidates, viewer, turnStart, tracking);
  }
  if (spec.encoder === "v2_lite") {
    return encodeCandidatesV2Lite(candidates, viewer, turnStart, tracking);
  }
  if (spec.encoder === "privileged") {
    return encodePrivilegedCandidates(turnStart, history, candidates.length);
  }
  if (spec.encoder === "board_centered_none") {
    return encodeCandidatesBoardCenteredNone(
      candidates,
      viewer,
      turnStart,
      history,
    );
  }
  return encodeCandidatesActionDelta(candidates, viewer, turnStart, tracking);
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
      reject(new AiTimeoutError(`${spec.label}の計算が10秒を超えました`));
    }, TIMEOUT_MS);
    const onMessage = (
      event: MessageEvent<{ id: number; scores?: ArrayBuffer; error?: string }>,
    ) => {
      if (event.data.id !== id) return;
      window.clearTimeout(timeout);
      cleanup();
      if (event.data.error || !event.data.scores) {
        reject(new Error(event.data.error ?? `${spec.label}の推論に失敗しました`));
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

export const actionDeltaEvaluationCandidates = (
  candidates: TurnCandidate[],
): TurnCandidate[] => candidates;

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
      const modelCandidates =
        spec.encoder === "action_delta"
          ? actionDeltaEvaluationCandidates(candidates)
          : candidates;
      const evaluations = await infer(
        spec,
        [...modelCandidates, ownCandidate],
        viewer,
        turnStart,
        tracking,
        history,
      );
      const own = evaluations.at(-1);
      if (!own) throw new Error("自分の手を評価できません");
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

const DEFAULT_PLAY_MODEL = MODEL_SPECS[1];

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
  if (!evaluations.length) throw new Error("評価できる候補手がありません");
  return evaluations.reduce((best, current) =>
    current.probability > best.probability ? current : best,
  );
};
