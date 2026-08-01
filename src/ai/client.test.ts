import { describe, expect, it } from "vitest";
import { actionDeltaEvaluationCandidates } from "./client";
import { createInitialState } from "../game/game";
import { enumerateTurnCandidates } from "../game/value";

describe("multi-model analysis", () => {
  it("passes every turn candidate to the action-delta model", () => {
    const state = createInitialState(4, 20260730);
    const candidates = enumerateTurnCandidates(state);
    const evaluated = actionDeltaEvaluationCandidates(candidates);
    expect(evaluated).toBe(candidates);
    expect(evaluated).toHaveLength(candidates.length);
    expect(evaluated.length).toBeGreaterThan(8);
  });
});
