import { describe, expect, it } from "vitest";
import {
  applyAction,
  applyKnownLegalAction,
  boardFitsInSomeFrame,
  canPlaceCardAt,
  createDeck,
  createInitialState,
  legalActions,
} from "./game";
import { playHeuristicTurn } from "./bot";
import { Card, COLORS, GameState, HAND_SIZE, positionKey } from "./types";

describe("game engine", () => {
  it("creates two copies of every color/rank card", () => {
    const deck = createDeck();
    expect(deck).toHaveLength(56);
    COLORS.forEach((color) => {
      for (let rankIndex = 0; rankIndex < 7; rankIndex += 1) {
        expect(
          deck.filter(
            (card) => card.color === color && card.rankIndex === rankIndex,
          ),
        ).toHaveLength(2);
      }
    });
  });

  it("deals four sorted hands and places the initial card", () => {
    const state = createInitialState(4, 1);
    expect(state.players).toHaveLength(4);
    expect(state.players.every((player) => player.hand.length === HAND_SIZE)).toBe(
      true,
    );
    expect(Object.keys(state.board)).toHaveLength(1);
    const [key, stack] = Object.entries(state.board)[0];
    expect(key).toBe(positionKey({ x: 3, y: stack[0].rankIndex }));
    expect(state.deck).toHaveLength(31);
  });

  it("enforces rank rows and color columns", () => {
    const redThree: Card = { color: "red", rankIndex: 2 };
    expect(canPlaceCardAt({}, redThree, { x: 0, y: 2 })).toBe(true);
    expect(canPlaceCardAt({}, redThree, { x: 0, y: 3 })).toBe(false);
    const board = { "3,2": [redThree] };
    expect(canPlaceCardAt(board, { color: "red", rankIndex: 4 }, { x: 3, y: 4 })).toBe(
      true,
    );
    expect(canPlaceCardAt(board, { color: "red", rankIndex: 4 }, { x: 2, y: 4 })).toBe(
      false,
    );
  });

  it("supports stacking and one-card turn end", () => {
    const state: GameState = {
      schemaVersion: 1,
      players: [
        {
          hand: [{ color: "red", rankIndex: 2 }],
          negativeCards: [],
          lossScore: 5,
        },
        ...Array.from({ length: 3 }, () => ({
          hand: [],
          negativeCards: [],
          lossScore: 5,
        })),
      ],
      board: { "3,2": [{ color: "red", rankIndex: 2 }] },
      deck: [],
      currentPlayerIndex: 0,
      phase: "play",
      cardsPlayedThisTurn: 0,
      winners: [],
      settlementCount: 0,
      lastTurnPlayCounts: [0, 0, 0, 0],
      randomState: 1,
    };
    const placed = applyAction(state, {
      type: "place",
      handIndex: 0,
      position: { x: 3, y: 2 },
      frame: { x: 2, y: 0 },
    });
    expect(placed.board["3,2"]).toHaveLength(2);
    const ended = applyAction(placed, { type: "end_turn" });
    expect(ended.currentPlayerIndex).toBe(0);
    expect(ended.phase).toBe("refill");
  });

  it("plays deterministic heuristic games to completion", () => {
    let state = createInitialState(4, 20260726);
    let turns = 0;
    while (state.phase !== "game_over" && turns < 2000) {
      state = playHeuristicTurn(state).state;
      expect(boardFitsInSomeFrame(state.board)).toBe(true);
      turns += 1;
    }
    expect(state.phase).toBe("game_over");
    expect(state.winners.length).toBeGreaterThan(0);
    expect(legalActions(state)).toHaveLength(0);
  });

  it("settles immediately when a deck refill draws the final card", () => {
    const state = createInitialState(4, 99);
    state.phase = "refill";
    state.players[0].hand = state.players[0].hand.slice(0, 5);
    state.deck = [state.deck[0]];
    const next = applyKnownLegalAction(state, {
      type: "refill",
      source: "deck",
    });
    expect(next.settlementCount).toBe(1);
    expect(next.deck).toHaveLength(0);
  });
});
