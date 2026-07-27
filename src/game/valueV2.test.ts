import { describe, expect, it } from "vitest";
import { GameState } from "./types";
import { canonicalRecordV2, VALUE_CONTEXT_SIZE_V2 } from "./valueV2";
import { CompletedTurnV2, PublicNegativePileV2 } from "./v2Tracking";

const state: GameState = {
  schemaVersion: 1,
  players: [
    { hand: [{ color: "green", rankIndex: 1 }, { color: "blue", rankIndex: 5 }], negativeCards: [{ color: "yellow", rankIndex: 3 }], lossScore: 4 },
    { hand: [{ color: "red", rankIndex: 0 }], negativeCards: [], lossScore: 6 },
    { hand: [], negativeCards: [], lossScore: 7 },
    { hand: [{ color: "blue", rankIndex: 6 }], negativeCards: [], lossScore: 8 },
  ],
  board: {
    "1,1": [{ color: "green", rankIndex: 1 }],
    "2,3": [{ color: "red", rankIndex: 3 }, { color: "red", rankIndex: 3 }],
    "4,5": [{ color: "blue", rankIndex: 5 }],
  },
  deck: Array.from({ length: 8 }, () => ({ color: "yellow" as const, rankIndex: 0 })),
  currentPlayerIndex: 0,
  phase: "refill",
  cardsPlayedThisTurn: 2,
  winners: [],
  settlementCount: 1,
  lastTurnPlayCounts: [0, 0, 0, 0],
  randomState: 0,
};
const history: CompletedTurnV2[] = [
  { playerIndex: 2, cards: [{ color: "red", rankIndex: 0 }], startFrame: { x: 0, y: 1 }, endFrame: { x: 1, y: 1 }, startBoardCardCount: 4, scoreDelta: 1, negativeCardDelta: 0, settlementOccurred: false, refillResult: "not_offered" },
  { playerIndex: 3, cards: [{ color: "green", rankIndex: 1 }, { color: "blue", rankIndex: 1 }], startFrame: { x: 1, y: 1 }, endFrame: { x: 3, y: 2 }, startBoardCardCount: 5, scoreDelta: 0, negativeCardDelta: 1, settlementOccurred: true, refillResult: "deck" },
];
const empty = (): PublicNegativePileV2 => ({
  rankExpected: [0, 0, 0, 0, 0, 0, 0],
  colorExpected: [0, 0, 0, 0],
  exact: true,
});

describe("V2 value input", () => {
  it("matches the Python strict_residual_v2 golden tensor", () => {
    const result = canonicalRecordV2({
      state,
      viewer: 0,
      history,
      frame: { startFrame: { x: 3, y: 2 }, endFrame: { x: 2, y: 0 }, startBoardCardCount: 6 },
      piles: [
        empty(),
        { rankExpected: [1, 0, 0, 0, 0, 0, 0], colorExpected: [0, 1, 0, 0], exact: true },
        { rankExpected: [0.5, 0, 0, 0, 0, 0, 0.5], colorExpected: [0.5, 0, 0.5, 0], exact: false },
        empty(),
      ],
      pending: "deck",
    });
    expect(result.context).toHaveLength(VALUE_CONTEXT_SIZE_V2);
    expect([...result.board.entries()].filter(([, value]) => value)).toEqual([
      [625, 1], [858, 2], [1090, 1], [1384, 1], [1397, 2], [1409, 1],
    ]);
    expect([...result.context.entries()].filter(([, value]) => value)).toEqual([
      [0,1],[2,1],[5,0.8333333134651184],[6,1],[10,1],[11,0.1666666716337204],[36,0.11428571492433548],[37,0.3333333432674408],[38,0.01785714365541935],[39,0.17142857611179352],[40,0.1666666716337204],[42,0.20000000298023224],[45,0.22857142984867096],[46,0.1666666716337204],[48,1],[53,1],[55,1],[56,0.10000000149011612],[59,1],[63,1],[114,1],[117,1],[119,0.5],[120,1],[125,1],[127,1],[134,1],[137,1],[141,0.0714285746216774],[142,0.25],[144,1],[147,1],[156,0.3333333432674408],[158,1],[163,1],[167,1],[168,1],[169,1],[173,1],[176,1],[181,1],[187,1],[190,0.0892857164144516],[191,0.5],[192,0.25],[193,1],[195,1],[198,0.1666666716337204],[199,1],[203,1],[204,0.1666666716337204],[206,0.1111111119389534],[209,1],[211,1],[212,1],[214,1],[220,1],[225,1],[228,1],[233,0.1071428582072258],[234,0.25],[235,0.5],[239,0.01785714365541935],[264,0.01785714365541935],[272,0.01785714365541935],[275,1],[276,0.008928571827709675],[282,0.008928571827709675],[285,0.008928571827709675],[286,0.008928571827709675],[299,1],
    ]);
  });
});
