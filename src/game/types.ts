export const BOARD_SIZE = 7;
export const FRAME_SIZE = 3;
export const HAND_SIZE = 6;
export const DEFAULT_LOSS_SCORE = 5;
export const GAME_END_LOSS_SCORE = 35;

export const COLORS = ["red", "blue", "green", "yellow"] as const;
export type Color = (typeof COLORS)[number];

export type Phase = "play" | "refill" | "game_over";
export type RefillSource = "deck" | "negative_cards" | "none";

export interface Card {
  color: Color;
  rankIndex: number;
}

export interface Position {
  x: number;
  y: number;
}

export interface Frame {
  x: number;
  y: number;
}

export type Board = Record<string, Card[]>;

export interface PlayerState {
  hand: Card[];
  negativeCards: Card[];
  lossScore: number;
}

export interface GameState {
  schemaVersion: 1;
  players: PlayerState[];
  board: Board;
  deck: Card[];
  currentPlayerIndex: number;
  phase: Phase;
  cardsPlayedThisTurn: number;
  winners: number[];
  settlementCount: number;
  lastTurnPlayCounts: number[];
  randomState: number;
}

export interface PlaceCardAction {
  type: "place";
  handIndex: number;
  position: Position;
  frame: Frame;
}

export interface EndTurnAction {
  type: "end_turn";
}

export interface RefillAction {
  type: "refill";
  source: RefillSource;
}

export type Action = PlaceCardAction | EndTurnAction | RefillAction;

export interface RecentPlacement {
  playerIndex: number;
  card: Card;
  scoreDelta: number;
  negativeCardDelta: number;
}

export const positionKey = ({ x, y }: Position): string => `${x},${y}`;

export const samePosition = (a: Position, b: Position): boolean =>
  a.x === b.x && a.y === b.y;

export const sameFrame = (a: Frame, b: Frame): boolean =>
  a.x === b.x && a.y === b.y;
