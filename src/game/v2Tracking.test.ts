import { describe, expect, it } from "vitest";
import { createInitialState } from "./game";
import { enumerateTurnCandidates } from "./value";
import {
  createV2Tracking,
  replayV2Actions,
  v2EvaluationState,
} from "./v2Tracking";

describe("V2 live tracking", () => {
  it("stores a completed turn without adding it to candidate history early", () => {
    const state = createInitialState(4, 21);
    const candidate = enumerateTurnCandidates(state).find((value) =>
      value.actions.some(
        (action) => action.type === "refill" && action.source === "deck",
      ),
    );
    expect(candidate).toBeDefined();
    const tracking = createV2Tracking(4);
    expect(tracking.history).toHaveLength(0);
    const replayed = replayV2Actions(
      state,
      candidate!.actions,
      tracking,
    );
    expect(replayed.tracking.history).toHaveLength(1);
    expect(replayed.tracking.history[0].cards.length).toBeGreaterThan(0);
    expect(replayed.tracking.activeTurn).toBeNull();
  });

  it("evaluates refill choices before drawing random cards", () => {
    const state = createInitialState(4, 22);
    const candidate = enumerateTurnCandidates(state).find((value) =>
      value.actions.some(
        (action) => action.type === "refill" && action.source === "deck",
      ),
    );
    expect(candidate).toBeDefined();
    const evaluation = v2EvaluationState(state, candidate!.actions);
    expect(evaluation.pendingRefillSource).toBe("deck");
    expect(evaluation.state.phase).toBe("refill");
    expect(evaluation.state.currentPlayerIndex).toBe(0);
    expect(evaluation.state.deck.length).toBe(state.deck.length);
  });
});
