import { describe, expect, it } from "vitest";
import { createInitialState } from "./game";
import {
  BOARD_CHANNELS,
  candidateGroupSignature,
  candidateRefillDecision,
  completeHumanCandidate,
  CONTEXT_SIZE,
  encodeCandidates,
  enumerateTurnCandidates,
  topDistinctCandidateEvaluations,
} from "./value";

describe("value model inputs", () => {
  it("enumerates complete one- and two-card turns", () => {
    const state = createInitialState(4, 1);
    const candidates = enumerateTurnCandidates(state);
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.some((candidate) => candidate.actions.length === 2)).toBe(
      true,
    );
    expect(
      candidates.every(
        (candidate) =>
          candidate.state.phase === "refill" ||
          candidate.state.currentPlayerIndex === 1,
      ),
    ).toBe(true);
  });

  it("encodes the exact ONNX batch shapes", () => {
    const state = createInitialState(4, 2);
    const candidates = enumerateTurnCandidates(state).slice(0, 3);
    const encoded = encodeCandidates(candidates, 0);
    expect(encoded.board).toHaveLength(3 * BOARD_CHANNELS * 7 * 7);
    expect(encoded.context).toHaveLength(3 * CONTEXT_SIZE);
    expect([...encoded.board].every(Number.isFinite)).toBe(true);
    expect([...encoded.context].every(Number.isFinite)).toBe(true);
  });

  it("reconstructs a selected human turn without mutating its start state", () => {
    const state = createInitialState(4, 3);
    const selected = enumerateTurnCandidates(state)[0];
    const placements = selected.actions.filter(
      (action) => action.type === "place",
    );
    const completed = completeHumanCandidate(state, placements, []);
    expect(completed).not.toBeNull();
    expect(completed?.state).toEqual(selected.state);
    expect(state.cardsPlayedThisTurn).toBe(0);
    expect(state.players[0].hand).toHaveLength(6);
  });

  it("excludes an explicit no-refill choice after two cards", () => {
    const state = createInitialState(4, 4);
    const selected = enumerateTurnCandidates(state).find(
      (candidate) =>
        candidate.actions.filter((action) => action.type === "place").length ===
          2 &&
        candidate.actions.some(
          (action) => action.type === "refill" && action.source === "none",
        ),
    );
    expect(selected).toBeUndefined();
    const twoCardCandidate = enumerateTurnCandidates(state).find(
      (candidate) =>
        candidate.actions.filter((action) => action.type === "place").length ===
        2,
    );
    expect(twoCardCandidate).toBeDefined();
    const placements = twoCardCandidate!.actions.filter(
      (action) => action.type === "place",
    );
    const completed = completeHumanCandidate(state, placements, [], {
      type: "refill",
      source: "none",
    });
    expect(completed).toBeNull();
  });

  it("completes a one-card turn that empties the hand after refill selection", () => {
    const state = createInitialState(4, 7);
    state.players[0].hand = [state.players[0].hand[0]];
    const selected = enumerateTurnCandidates(state).find(
      (candidate) =>
        candidate.actions.filter((action) => action.type === "place").length ===
          1 &&
        candidate.actions.some(
          (action) => action.type === "refill" && action.source === "deck",
        ),
    );
    expect(selected).toBeDefined();
    const placements = selected!.actions.filter(
      (action) => action.type === "place",
    );
    expect(completeHumanCandidate(state, placements, [])).toBeNull();
    const completed = completeHumanCandidate(state, placements, [], {
      type: "refill",
      source: "deck",
    });
    expect(completed).not.toBeNull();
    expect(completed?.actions.map((action) => action.type)).toEqual([
      "place",
      "end_turn",
      "refill",
    ]);
    expect(completed?.state.currentPlayerIndex).toBe(1);
  });

  it("groups frame and order variants but keeps refill decisions separate", () => {
    const state = createInitialState(4, 5);
    const candidates = enumerateTurnCandidates(state);
    const groups = new Map<string, typeof candidates>();
    candidates.forEach((candidate) => {
      const signature = candidateGroupSignature(state, candidate.actions);
      groups.set(signature, [...(groups.get(signature) ?? []), candidate]);
    });
    const duplicated = [...groups.values()].find((group) => group.length > 1);
    expect(duplicated).toBeDefined();
    const evaluations = duplicated!.map((candidate, index) => ({
      candidate,
      probability: 0.4 + index / 100,
    }));
    const result = topDistinctCandidateEvaluations(state, evaluations, 3);
    expect(result).toHaveLength(1);
    expect(result[0].probability).toBe(
      Math.max(...evaluations.map((value) => value.probability)),
    );

    const deckCandidate = candidates.find(
      (candidate) =>
        candidate.actions.filter((action) => action.type === "place").length ===
          2 &&
        candidate.actions.some(
          (action) => action.type === "refill" && action.source === "deck",
        ),
    );
    expect(deckCandidate).toBeDefined();
    const noneCandidate = {
      ...deckCandidate!,
      actions: [
        ...deckCandidate!.actions.slice(0, -1),
        { type: "refill" as const, source: "none" as const },
      ],
    };
    const refillResults = topDistinctCandidateEvaluations(
      state,
      [
        { candidate: deckCandidate!, probability: 0.4 },
        { candidate: noneCandidate, probability: 0.5 },
      ],
      10,
    );
    expect(refillResults.map((value) =>
      candidateRefillDecision(value.candidate.actions),
    )).toEqual(["none", "deck"]);
  });

  it("returns at most three distinct card-and-refill decisions", () => {
    const state = createInitialState(4, 6);
    const candidates = enumerateTurnCandidates(state);
    const evaluations = candidates.map((candidate, index) => ({
      candidate,
      probability: index / candidates.length,
    }));
    const result = topDistinctCandidateEvaluations(state, evaluations, 3);
    expect(result).toHaveLength(3);
    expect(
      new Set(
        result.map((value) =>
          candidateGroupSignature(state, value.candidate.actions),
        ),
      ).size,
    ).toBe(3);
  });
});
