import { describe, expect, it } from "vitest";
import { encodePrivilegedCandidates, PRIVILEGED_CONTEXT_SIZE, PRIVILEGED_BOARD_CHANNELS } from "./valuePrivileged";
import { GameState } from "./types";

const state: GameState = {
  schemaVersion: 1,
  players: [
    { hand: [{ color: "red", rankIndex: 1 }], negativeCards: [], lossScore: 0 },
    { hand: [{ color: "blue", rankIndex: 4 }], negativeCards: [{ color: "yellow", rankIndex: 6 }], lossScore: 7 },
    { hand: [], negativeCards: [], lossScore: 2 },
    { hand: [], negativeCards: [], lossScore: 3 },
  ],
  board: { "3,2": [{ color: "green", rankIndex: 2 }] },
  deck: Array.from({ length: 10 }, () => ({ color: "red", rankIndex: 0 })),
  currentPlayerIndex: 0,
  phase: "play",
  cardsPlayedThisTurn: 0,
  winners: [],
  settlementCount: 1,
  lastTurnPlayCounts: [0, 0, 0, 0],
  randomState: 1,
};

describe("privileged pre-play input", () => {
  it("creates repeated candidate tensors with the documented dimensions", () => {
    const result = encodePrivilegedCandidates(state, [], 3);
    expect(result.board).toHaveLength(3 * PRIVILEGED_BOARD_CHANNELS * 49);
    expect(result.context).toHaveLength(3 * PRIVILEGED_CONTEXT_SIZE);
    expect(result.board[2 * PRIVILEGED_BOARD_CHANNELS * 49 + 28 * 49 + 2 * 7 + 3]).toBe(1);
    expect(result.context[0]).toBe(1);
    expect(result.context[PRIVILEGED_CONTEXT_SIZE]).toBe(1);
  });

  it("includes other players' hands in the context", () => {
    const changed = structuredClone(state);
    changed.players[1].hand = [{ color: "yellow", rankIndex: 0 }];
    const original = encodePrivilegedCandidates(state, [], 1).context;
    const updated = encodePrivilegedCandidates(changed, [], 1).context;
    expect([...original]).not.toEqual([...updated]);
  });
});
