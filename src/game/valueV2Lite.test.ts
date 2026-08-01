import { describe, expect, it } from "vitest";
import {
  ACTION_DELTA_CONTEXT_SIZE,
  canonicalRecordV2Lite,
  encodeActionCards,
  VALUE_CONTEXT_SIZE_V2_LITE,
} from "./valueV2Lite";
import { GameState } from "./types";
import { CompletedTurnV2 } from "./v2Tracking";

const after: GameState = {
  schemaVersion: 1,
  players: [
    {
      hand: [
        { color: "green", rankIndex: 1 },
        { color: "blue", rankIndex: 5 },
      ],
      negativeCards: [{ color: "yellow", rankIndex: 3 }],
      lossScore: 4,
    },
    {
      hand: [{ color: "red", rankIndex: 0 }],
      negativeCards: [],
      lossScore: 6,
    },
    { hand: [], negativeCards: [], lossScore: 7 },
    {
      hand: [{ color: "blue", rankIndex: 6 }],
      negativeCards: [],
      lossScore: 8,
    },
  ],
  board: {
    "1,1": [{ color: "green", rankIndex: 1 }],
    "2,3": [
      { color: "red", rankIndex: 3 },
      { color: "red", rankIndex: 3 },
    ],
    "4,5": [{ color: "blue", rankIndex: 5 }],
  },
  deck: Array.from({ length: 8 }, () => ({
    color: "yellow" as const,
    rankIndex: 0,
  })),
  currentPlayerIndex: 0,
  phase: "refill",
  cardsPlayedThisTurn: 2,
  winners: [],
  settlementCount: 1,
  lastTurnPlayCounts: [0, 0, 0, 0],
  randomState: 0,
};

const before: GameState = {
  ...structuredClone(after),
  players: [
    {
      ...structuredClone(after.players[0]),
      hand: [
        { color: "yellow", rankIndex: 0 },
        ...after.players[0].hand,
      ],
    },
    ...structuredClone(after.players.slice(1)),
  ],
  board: {
    "1,1": [{ color: "green", rankIndex: 1 }],
    "2,3": [{ color: "red", rankIndex: 3 }],
    "4,5": [{ color: "blue", rankIndex: 5 }],
  },
  phase: "play",
  cardsPlayedThisTurn: 0,
};

const history: CompletedTurnV2[] = [
  {
    playerIndex: 2,
    cards: [{ color: "red", rankIndex: 0 }],
    startFrame: { x: 0, y: 1 },
    endFrame: { x: 1, y: 1 },
    startBoardCardCount: 4,
    scoreDelta: 1,
    negativeCardDelta: 0,
    settlementOccurred: false,
    refillResult: "not_offered",
  },
  {
    playerIndex: 3,
    cards: [
      { color: "green", rankIndex: 1 },
      { color: "blue", rankIndex: 1 },
    ],
    startFrame: { x: 1, y: 1 },
    endFrame: { x: 3, y: 2 },
    startBoardCardCount: 5,
    scoreDelta: 0,
    negativeCardDelta: 1,
    settlementOccurred: true,
    refillResult: "deck",
  },
];

describe("V2-lite value input", () => {
  it("matches the Python strict_residual_v2_lite golden tensor", () => {
    const result = canonicalRecordV2Lite({
      before,
      after,
      viewer: 0,
      history,
      pending: "deck",
    });
    expect(result.context).toHaveLength(VALUE_CONTEXT_SIZE_V2_LITE);
    expect(ACTION_DELTA_CONTEXT_SIZE).toBe(150);
    expect(result.transform).toEqual({
      vertical: false,
      horizontal: true,
      mapping: [2, 1, 3, 0],
    });
    expect([...result.board.entries()].filter(([, value]) => value)).toEqual([
      [625, 1],
      [858, 2],
      [1090, 1],
      [1384, 1],
      [1397, 2],
      [1409, 1],
      [2279, 1],
      [2818, 1],
    ]);
    expect([...result.context.entries()].filter(([, value]) => value)).toEqual([
      [0,1],[2,1],[5,0.8333333134651184],[6,1],[10,1],[11,0.1666666716337204],
      [36,0.11428571492433548],[37,0.3333333432674408],[38,0.01785714365541935],
      [39,0.17142857611179352],[40,0.1666666716337204],[42,0.20000000298023224],
      [45,0.22857142984867096],[46,0.1666666716337204],[48,1],[53,1],[55,1],
      [56,0.10000000149011612],[59,1],[63,1],[65,1],[68,1],[70,0.5],[71,1],
      [74,1],[83,0.3333333432674408],[85,1],[90,1],[94,1],[95,1],[96,1],
      [98,1],[101,0.1666666716337204],[102,1],[106,1],[107,0.1666666716337204],
      [109,0.1111111119389534],[112,1],[114,1],[118,0.01785714365541935],
      [122,0.01785714365541935],[126,0.11428571492433548],[127,0.5],
      [128,0.01785714365541935],[129,0.17142857611179352],
      [130,0.1666666716337204],[132,0.20000000298023224],
      [135,0.22857142984867096],[136,0.1666666716337204],
    ]);
    expect(
      encodeActionCards(
        [
          { color: "yellow", rankIndex: 0 },
          { color: "red", rankIndex: 3 },
        ],
        result.transform,
      ),
    ).toEqual([1, 1, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0.5]);
  });
});
