/* Browser inference worker. Runtime is pinned; the model is served locally. */
const ORT_VERSION = "1.20.1";
const ORT_ROOT = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;
importScripts(`${ORT_ROOT}ort.min.js`);

self.ort.env.wasm.wasmPaths = ORT_ROOT;
self.ort.env.wasm.numThreads = 1;
let sessionPromise;

const sessionFor = (modelUrl) => {
  sessionPromise ??= self.ort.InferenceSession.create(modelUrl, {
    executionProviders: ["wasm"],
    graphOptimizationLevel: "all",
  });
  return sessionPromise;
};

self.addEventListener("message", async (event) => {
  const { type, id, count, board, context, modelUrl } = event.data;
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
        29,
        7,
        7,
      ]),
      context: new self.ort.Tensor("float32", new Float32Array(context), [
        count,
        300,
      ]),
    };
    const output = await session.run(feeds);
    const logits = output.logit.data;
    const probabilities = new Float32Array(logits.length);
    for (let index = 0; index < logits.length; index += 1) {
      probabilities[index] = 1 / (1 + Math.exp(-logits[index]));
    }
    self.postMessage({ id, probabilities: probabilities.buffer }, [
      probabilities.buffer,
    ]);
  } catch (error) {
    self.postMessage({
      id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
