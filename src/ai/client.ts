import {
  applyActionTrackingHistory,
  candidateGroupSignature,
  encodeCandidatesV1AtDecisionBoundary,
  playedCardsSignature,
  TurnCandidate,
  TurnEvaluation,
} from "../game/value";
import { GameState, RecentPlacement } from "../game/types";
import { shuffled } from "../game/random";
import { encodeCandidatesV2 } from "../game/valueV2";
import {
  encodeCandidatesActionDelta,
  encodeCandidatesV2Lite,
} from "../game/valueV2Lite";
import { encodeCandidatesBoardCenteredNone } from "../game/valueBoardCentered";
import { encodeCandidatesBoardColumnsV1 } from "../game/valueBoardColumns";
import { V2TrackingState } from "../game/v2Tracking";
import {
  encodePrivilegedCandidates,
  encodePrivilegedSafeCountCandidates,
  encodePrivilegedSafeCountStateInputs,
  PrivilegedSafeCountStateInput,
} from "../game/valuePrivileged";

const TIMEOUT_MS = 30_000;
let worker: Worker | null = null;
let requestId = 0;

export type ModelId =
  | "preplay-v1-current"
  | "preplay-safe-counts-generation0-197800-epoch001"
  | "v1-generation0-epoch002"
  | "canonical-old-001"
  | "v2-generation0-epoch001"
  | "action-delta-selected"
  | "v1-new-88966-epoch001"
  | "v1-exploratory-59826-epoch001"
  | "v1-board-centered-explore-none-76919-epoch001"
  | "v1-6h-snapshot-canonical-epoch001"
  | "v1-6h-snapshot-board-columns-v1-epoch001";
export type ScoreKind = "probability" | "delta";
type EncoderKind =
  | "v1"
  | "v2"
  | "v2_lite"
  | "action_delta"
  | "privileged"
  | "privileged_safe_counts"
  | "board_centered_none"
  | "board_columns_v1";

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
    id: "preplay-v1-current",
    label: "Pre-play V1 current (privileged preview)",
    boardChannels: 29,
    contextSize: 190,
    scoreKind: "probability",
    outputTransform: "identity",
    encoder: "privileged",
    grouping: "cards",
  },
  {
    id: "preplay-safe-counts-generation0-197800-epoch001",
    label: "Pre-play safe/one-off gen0 197,800 epoch001",
    boardChannels: 29,
    contextSize: 199,
    scoreKind: "probability",
    outputTransform: "identity",
    encoder: "privileged_safe_counts",
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
    id: "canonical-old-001",
    label: "Canonical old 660k epoch001",
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
    label: "Action delta selected",
    boardChannels: 58,
    contextSize: 150,
    scoreKind: "delta",
    outputTransform: "identity",
    encoder: "action_delta",
    grouping: "cards",
  },
  {
    id: "v1-new-88966-epoch001",
    label: "Original V1 new 88,966 games epoch001",
    boardChannels: 29,
    contextSize: 81,
    scoreKind: "probability",
    outputTransform: "sigmoid",
    encoder: "v1",
    grouping: "cards",
  },
  {
    id: "v1-exploratory-59826-epoch001",
    label: "V1 explore 59,826 games epoch001",
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
    id: "v1-6h-snapshot-board-columns-v1-epoch001",
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

export const PLAYABLE_MODEL_SPECS = MODEL_SPECS.filter(
  (spec) => !spec.encoder.startsWith("privileged"),
);

export interface ModelAnalysis {
  spec: ModelSpec;
  status: "ok" | "error";
  own?: TurnEvaluation;
  top: TurnEvaluation[];
  all: TurnEvaluation[];
  preplayBeforeProbability?: number;
  preplayPostSampleCount?: number;
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
  if (spec.encoder === "privileged_safe_counts") {
    return encodePrivilegedSafeCountCandidates(
      turnStart,
      history,
      candidates.length,
    );
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

const inferRaw = async (
  spec: ModelSpec,
  board: Float32Array,
  context: Float32Array,
  count: number,
): Promise<Float32Array> => {
  const active = activeWorker();
  const id = ++requestId;
  return new Promise<Float32Array>((resolve, reject) => {
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
      resolve(new Float32Array(event.data.scores));
    };
    active.addEventListener("message", onMessage);
    active.postMessage(
      {
        type: "infer",
        id,
        modelUrl: modelUrl(spec.id),
        count,
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

const sampledRandomState = (randomState: number, sample: number): number =>
  (randomState + Math.imul(0x9e3779b9, sample + 1)) >>> 0;

const postPlayInputsForCandidate = (
  turnStart: GameState,
  history: RecentPlacement[],
  candidate: TurnCandidate,
  viewer: number,
): PrivilegedSafeCountStateInput[] => {
  const refill = candidate.actions.find((action) => action.type === "refill");
  if (!refill || refill.source === "none") {
    return [{ state: candidate.state, history: candidate.history, viewer }];
  }
  return Array.from({ length: 10 }, (_, sample) => {
    let state: GameState = {
      ...turnStart,
      randomState: sampledRandomState(turnStart.randomState, sample),
    };
    let nextHistory = history;
    for (const action of candidate.actions) {
      if (action.type === "refill" && action.source === "deck") {
        const [deck, randomState] = shuffled(
          state.deck,
          sampledRandomState(state.randomState, sample),
        );
        state = { ...state, deck, randomState };
      }
      const applied = applyActionTrackingHistory(state, action, nextHistory);
      state = applied.state;
      nextHistory = applied.history;
    }
    return { state, history: nextHistory, viewer };
  });
};

const inferPrivilegedSafeCounts = async (
  spec: ModelSpec,
  candidates: TurnCandidate[],
  viewer: number,
  turnStart: GameState,
  history: RecentPlacement[],
): Promise<{
  evaluations: TurnEvaluation[];
  beforeProbability: number;
  postSampleCount: number;
}> => {
  if (!candidates.length) {
    return { evaluations: [], beforeProbability: 0, postSampleCount: 0 };
  }
  const beforeTensors = encodePrivilegedSafeCountStateInputs([
    { state: turnStart, history, viewer },
  ]);
  const beforeScores = await inferRaw(
    spec,
    beforeTensors.board,
    beforeTensors.context,
    1,
  );
  const inputsByCandidate = candidates.map((candidate) =>
    postPlayInputsForCandidate(turnStart, history, candidate, viewer),
  );
  const postInputs = inputsByCandidate.flat();
  const postTensors = encodePrivilegedSafeCountStateInputs(postInputs);
  const postScores = await inferRaw(
    spec,
    postTensors.board,
    postTensors.context,
    postInputs.length,
  );
  let offset = 0;
  const evaluations = candidates.map((candidate, index) => {
    const inputs = inputsByCandidate[index];
    const sum = inputs.reduce((total) => total + postScores[offset++], 0);
    return { candidate, probability: sum / inputs.length };
  });
  return {
    evaluations,
    beforeProbability: beforeScores[0],
    postSampleCount: 10,
  };
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
      const evaluatedCandidates = [...modelCandidates, ownCandidate];
      const privilegedSafeCounts =
        spec.encoder === "privileged_safe_counts"
          ? await inferPrivilegedSafeCounts(
              spec,
              evaluatedCandidates,
              viewer,
              turnStart,
              history,
            )
          : null;
      const evaluations =
        privilegedSafeCounts?.evaluations ??
        (await infer(
          spec,
          evaluatedCandidates,
          viewer,
          turnStart,
          tracking,
          history,
        ));
      const own = evaluations.at(-1);
      if (!own) throw new Error("own move could not be evaluated");
      const all = evaluations.slice(0, -1);
      results.push({
        spec,
        status: "ok",
        own,
        top: topFor(spec, turnStart, all),
        all,
        preplayBeforeProbability: privilegedSafeCounts?.beforeProbability,
        preplayPostSampleCount: privilegedSafeCounts?.postSampleCount,
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
const DEFAULT_PREPLAY_MODEL = MODEL_SPECS.find(
  (spec) => spec.id === "preplay-safe-counts-generation0-197800-epoch001",
) ?? MODEL_SPECS[0];

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

export const evaluatePreplayBefore = async (
  viewer: number,
  turnStart: GameState,
  history: RecentPlacement[] = [],
  modelId: ModelId = DEFAULT_PREPLAY_MODEL.id,
): Promise<{ spec: ModelSpec; probability: number }> => {
  const spec =
    MODEL_SPECS.find(
      (value) => value.id === modelId && value.encoder === "privileged_safe_counts",
    ) ?? DEFAULT_PREPLAY_MODEL;
  const tensors = encodePrivilegedSafeCountStateInputs([
    { state: turnStart, history, viewer },
  ]);
  const scores = await inferRaw(spec, tensors.board, tensors.context, 1);
  return { spec, probability: scores[0] };
};

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
