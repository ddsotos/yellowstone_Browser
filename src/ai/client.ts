import {
  encodeCandidates,
  TurnCandidate,
  TurnEvaluation,
} from "../game/value";

const TIMEOUT_MS = 10_000;
let worker: Worker | null = null;
let requestId = 0;
let readyPromise: Promise<void> | null = null;

const createWorker = (): Worker =>
  new Worker(`${import.meta.env.BASE_URL}ai-worker.js`);

export class AiTimeoutError extends Error {}

const modelUrl = (): string =>
  new URL(
    `${import.meta.env.BASE_URL}models/win_value.onnx`,
    window.location.href,
  ).href;

const ensureReady = (): Promise<void> => {
  if (readyPromise) return readyPromise;
  worker ??= createWorker();
  const activeWorker = worker;
  const id = ++requestId;
  readyPromise = new Promise<void>((resolve, reject) => {
    const fail = (message: string) => {
      window.clearTimeout(setupTimeout);
      activeWorker.removeEventListener("message", onMessage);
      activeWorker.removeEventListener("error", onError);
      activeWorker.terminate();
      if (worker === activeWorker) worker = null;
      readyPromise = null;
      reject(new Error(message));
    };
    const onError = (event: ErrorEvent) => {
      fail(event.message || "AIランタイムを読み込めません");
    };
    const onMessage = (
      event: MessageEvent<{ id: number; ready?: boolean; error?: string }>,
    ) => {
      if (event.data.id !== id) return;
      activeWorker.removeEventListener("message", onMessage);
      activeWorker.removeEventListener("error", onError);
      window.clearTimeout(setupTimeout);
      if (event.data.error || !event.data.ready) {
        fail(event.data.error ?? "AIモデルを準備できません");
        return;
      }
      resolve();
    };
    const setupTimeout = window.setTimeout(
      () => fail("AIモデルの準備が30秒を超えました"),
      30_000,
    );
    activeWorker.addEventListener("message", onMessage);
    activeWorker.addEventListener("error", onError);
    activeWorker.postMessage({ type: "init", id, modelUrl: modelUrl() });
  });
  return readyPromise;
};

export const warmAi = (): void => {
  void ensureReady().catch(() => {
    // The game remains playable with the heuristic fallback.
  });
};

export const evaluateCandidates = async (
  candidates: TurnCandidate[],
  viewer: number,
): Promise<TurnEvaluation[]> => {
  if (!candidates.length) return [];
  await ensureReady();
  const activeWorker = worker!;
  const id = ++requestId;
  const { board, context } = encodeCandidates(candidates, viewer);

  return new Promise<TurnEvaluation[]>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      activeWorker.terminate();
      if (worker === activeWorker) {
        worker = null;
        readyPromise = null;
      }
      reject(new AiTimeoutError("AI計算が10秒を超えました"));
    }, TIMEOUT_MS);

    const onMessage = (
      event: MessageEvent<{
        id: number;
        probabilities?: ArrayBuffer;
        error?: string;
      }>,
    ) => {
      if (event.data.id !== id) return;
      window.clearTimeout(timeout);
      activeWorker.removeEventListener("message", onMessage);
      if (event.data.error || !event.data.probabilities) {
        reject(new Error(event.data.error ?? "AI推論に失敗しました"));
        return;
      }
      const probabilities = new Float32Array(event.data.probabilities);
      resolve(
        candidates.map((candidate, index) => ({
          candidate,
          probability: probabilities[index],
        })),
      );
    };
    activeWorker.addEventListener("message", onMessage);
    activeWorker.postMessage(
      {
        id,
        count: candidates.length,
        board: board.buffer,
        context: context.buffer,
      },
      [board.buffer, context.buffer],
    );
  });
};

export const selectBestTurn = async (
  candidates: TurnCandidate[],
  viewer: number,
): Promise<TurnEvaluation> => {
  const evaluations = await evaluateCandidates(candidates, viewer);
  if (!evaluations.length) throw new Error("評価できる候補手がありません");
  return evaluations.reduce((best, current) =>
    current.probability > best.probability ? current : best,
  );
};
