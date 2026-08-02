/* Browser inference worker. Runtime is pinned; every model is served locally. */
const ORT_VERSION = "1.20.1";
const ORT_ROOT = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;
importScripts(`${ORT_ROOT}ort.min.js`);

self.ort.env.wasm.wasmPaths = ORT_ROOT;
self.ort.env.wasm.numThreads = 1;
const sessions = new Map();

const sessionFor = (modelUrl) => {
  let session = sessions.get(modelUrl);
  if (!session) {
    session = self.ort.InferenceSession.create(modelUrl, {
      executionProviders: ["wasm"],
      graphOptimizationLevel: "all",
    });
    sessions.set(modelUrl, session);
  }
  return session;
};

self.addEventListener("message", async (event) => {
  const {
    type,
    id,
    count,
    board,
    context,
    modelUrl,
    boardChannels,
    boardSize,
    boardHeight,
    boardWidth,
    contextSize,
    outputTransform,
  } = event.data;
  try {
    if (type === "init") {
      await sessionFor(modelUrl);
      self.postMessage({ id, ready: true });
      return;
    }
    const session = await sessionFor(modelUrl);
    const feeds = {
      board: new self.ort.Tensor("float32", new Float32Array(board), [
        count,
        boardChannels,
        boardHeight ?? boardSize ?? 7,
        boardWidth ?? boardSize ?? 7,
      ]),
      context: new self.ort.Tensor("float32", new Float32Array(context), [
        count,
        contextSize,
      ]),
    };
    const output = await session.run(feeds);
    const raw = output.score.data;
    const scores = new Float32Array(raw.length);
    for (let index = 0; index < raw.length; index += 1) {
      scores[index] =
        outputTransform === "sigmoid"
          ? 1 / (1 + Math.exp(-raw[index]))
          : raw[index];
    }
    self.postMessage({ id, scores: scores.buffer }, [scores.buffer]);
  } catch (error) {
    self.postMessage({
      id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
