import {
  Action,
  Board,
  BOARD_SIZE,
  Card,
  COLORS,
  DEFAULT_LOSS_SCORE,
  EndTurnAction,
  Frame,
  FRAME_SIZE,
  GAME_END_LOSS_SCORE,
  GameState,
  HAND_SIZE,
  PlaceCardAction,
  PlayerState,
  Position,
  RefillAction,
  positionKey,
  sameFrame,
  samePosition,
} from "./types";
import { shuffled } from "./random";

export class InvalidActionError extends Error {}

export const createDeck = (): Card[] =>
  COLORS.flatMap((color) =>
    Array.from({ length: BOARD_SIZE }, (_, rankIndex) => [
      { color, rankIndex },
      { color, rankIndex },
    ]).flat(),
  );

export const sortHand = (hand: readonly Card[]): Card[] =>
  [...hand].sort(
    (a, b) => a.rankIndex - b.rankIndex || a.color.localeCompare(b.color),
  );

const draw = (cards: Card[], count: number): Card[] =>
  cards.splice(0, Math.min(count, cards.length));

export const createInitialState = (
  playerCount = 4,
  seed = Date.now() >>> 0,
  startingLossScore = DEFAULT_LOSS_SCORE,
): GameState => {
  if (playerCount !== 4) throw new Error("初版は4人戦のみ対応しています");
  let deck: Card[];
  let randomState: number;
  [deck, randomState] = shuffled(createDeck(), seed);
  const players = Array.from({ length: playerCount }, (): PlayerState => ({
    hand: sortHand(draw(deck, HAND_SIZE)),
    negativeCards: [],
    lossScore: startingLossScore,
  }));
  const initialCard = deck.shift();
  if (!initialCard) throw new Error("初期カードがありません");
  const position = { x: Math.floor(BOARD_SIZE / 2), y: initialCard.rankIndex };
  return {
    schemaVersion: 1,
    players,
    board: { [positionKey(position)]: [initialCard] },
    deck,
    currentPlayerIndex: 0,
    phase: "play",
    cardsPlayedThisTurn: 0,
    winners: [],
    settlementCount: 0,
    lastTurnPlayCounts: players.map(() => 0),
    randomState,
  };
};

export const allFrames = (): Frame[] =>
  Array.from({ length: BOARD_SIZE - FRAME_SIZE + 1 }, (_, y) =>
    Array.from(
      { length: BOARD_SIZE - FRAME_SIZE + 1 },
      (__, x): Frame => ({ x, y }),
    ),
  ).flat();

export const framePositions = (frame: Frame): Position[] =>
  Array.from({ length: FRAME_SIZE }, (_, y) =>
    Array.from(
      { length: FRAME_SIZE },
      (__, x): Position => ({ x: frame.x + x, y: frame.y + y }),
    ),
  ).flat();

export const framesContaining = (position: Position): Frame[] =>
  allFrames().filter((frame) =>
    framePositions(frame).some((candidate) => samePosition(candidate, position)),
  );

export const boardEntries = (board: Board): [Position, Card[]][] =>
  Object.entries(board).map(([key, stack]) => {
    const [x, y] = key.split(",").map(Number);
    return [{ x, y }, stack];
  });

export const boardFitsInSomeFrame = (board: Board): boolean => {
  const occupied = boardEntries(board).map(([position]) => position);
  return allFrames().some((frame) => {
    const inside = framePositions(frame);
    return occupied.every((position) =>
      inside.some((candidate) => samePosition(candidate, position)),
    );
  });
};

export const columnsContainingColor = (board: Board, color: Card["color"]): number[] =>
  [
    ...new Set(
      boardEntries(board)
        .filter(([, stack]) => stack.some((card) => card.color === color))
        .map(([position]) => position.x),
    ),
  ];

export const colorsInColumn = (board: Board, x: number): Set<Card["color"]> =>
  new Set(
    boardEntries(board)
      .filter(([position]) => position.x === x)
      .flatMap(([, stack]) => stack.map((card) => card.color)),
  );

export const canPlaceCardAt = (
  board: Board,
  card: Card,
  position: Position,
): boolean => {
  if (
    position.x < 0 ||
    position.x >= BOARD_SIZE ||
    position.y !== card.rankIndex
  ) {
    return false;
  }
  const colorColumns = columnsContainingColor(board, card.color);
  if (colorColumns.length) return colorColumns.includes(position.x);
  const colors = colorsInColumn(board, position.x);
  return colors.size === 0 || (colors.size === 1 && colors.has(card.color));
};

export const legalPositionsForCard = (board: Board, card: Card): Position[] =>
  Array.from({ length: BOARD_SIZE }, (_, x) => ({ x, y: card.rankIndex })).filter(
    (position) => canPlaceCardAt(board, card, position),
  );

const legalRefillActions = (state: GameState): RefillAction[] => {
  const player = state.players[state.currentPlayerIndex];
  if (player.hand.length) {
    return [
      { type: "refill", source: "deck" },
      { type: "refill", source: "none" },
    ];
  }
  const result: RefillAction[] = [{ type: "refill", source: "deck" }];
  if (player.negativeCards.length >= HAND_SIZE) {
    result.push({ type: "refill", source: "negative_cards" });
  }
  return result;
};

export const legalActions = (state: GameState): Action[] => {
  if (state.phase === "game_over") return [];
  if (state.phase === "refill") return legalRefillActions(state);
  const result: Action[] = [];
  if (state.cardsPlayedThisTurn === 1) {
    result.push({ type: "end_turn" });
  }
  if (state.cardsPlayedThisTurn >= 2) return result;
  const player = state.players[state.currentPlayerIndex];
  if (!player.hand.length && state.cardsPlayedThisTurn === 0) {
    return legalRefillActions(state);
  }
  player.hand.forEach((card, handIndex) => {
    legalPositionsForCard(state.board, card).forEach((position) => {
      framesContaining(position).forEach((frame) => {
        result.push({ type: "place", handIndex, position, frame });
      });
    });
  });
  return result;
};

const cloneState = (state: GameState): GameState =>
  structuredClone(state) as GameState;

const actionEquals = (a: Action, b: Action): boolean => {
  if (a.type !== b.type) return false;
  if (a.type === "end_turn" && b.type === "end_turn") return true;
  if (a.type === "refill" && b.type === "refill") return a.source === b.source;
  if (a.type === "place" && b.type === "place") {
    return (
      a.handIndex === b.handIndex &&
      samePosition(a.position, b.position) &&
      sameFrame(a.frame, b.frame)
    );
  }
  return false;
};

export const applyAction = (state: GameState, action: Action): GameState => {
  if (!legalActions(state).some((legal) => actionEquals(legal, action))) {
    throw new InvalidActionError(`不正なアクション: ${JSON.stringify(action)}`);
  }
  return applyKnownLegalAction(state, action);
};

export const applyKnownLegalAction = (
  state: GameState,
  action: Action,
): GameState => {
  if (action.type === "place") return applyPlaceCard(state, action);
  if (action.type === "end_turn") return applyEndTurn(state, action);
  return applyRefill(state, action);
};

const occupiedCountInFrame = (board: Board, frame: Frame): number => {
  const inside = framePositions(frame);
  return boardEntries(board).filter(([position]) =>
    inside.some((candidate) => samePosition(candidate, position)),
  ).length;
};

const positiveScoreDelta = (
  occupiedBefore: number,
  occupiedAfter: number,
  wasOccupied: boolean,
): number => {
  if (wasOccupied) return 0;
  if (occupiedBefore < 8 && occupiedAfter >= 8) return 1;
  if (occupiedBefore < 9 && occupiedAfter >= 9) return 3;
  return 0;
};

const applyPlaceCard = (
  state: GameState,
  action: PlaceCardAction,
): GameState => {
  const next = cloneState(state);
  const player = next.players[next.currentPlayerIndex];
  const [card] = player.hand.splice(action.handIndex, 1);
  const key = positionKey(action.position);
  const occupiedBefore = occupiedCountInFrame(next.board, action.frame);
  const wasOccupied = key in next.board;
  next.board[key] = [...(next.board[key] ?? []), card];
  const occupiedAfter = occupiedCountInFrame(next.board, action.frame);
  const inside = new Set(framePositions(action.frame).map(positionKey));
  const kept: Board = {};
  Object.entries(next.board).forEach(([position, stack]) => {
    if (inside.has(position)) kept[position] = stack;
    else player.negativeCards.push(...stack);
  });
  next.board = kept;
  player.lossScore = Math.max(
    0,
    player.lossScore -
      positiveScoreDelta(occupiedBefore, occupiedAfter, wasOccupied),
  );
  next.cardsPlayedThisTurn += 1;
  next.phase = next.cardsPlayedThisTurn === 2 ? "refill" : "play";
  return next;
};

const updatedLastTurnCounts = (state: GameState): number[] => {
  const counts =
    state.lastTurnPlayCounts.length === state.players.length
      ? [...state.lastTurnPlayCounts]
      : state.players.map(() => 0);
  counts[state.currentPlayerIndex] = state.cardsPlayedThisTurn;
  return counts;
};

const advance = (state: GameState): GameState => ({
  ...cloneState(state),
  currentPlayerIndex: (state.currentPlayerIndex + 1) % state.players.length,
  phase: "play",
  cardsPlayedThisTurn: 0,
  lastTurnPlayCounts: updatedLastTurnCounts(state),
});

const applyEndTurn = (
  state: GameState,
  _action: EndTurnAction,
): GameState => {
  if (state.players[state.currentPlayerIndex].hand.length) return advance(state);
  return { ...cloneState(state), phase: "refill" };
};

export const winnerIndexes = (state: GameState): number[] => {
  if (state.players.every((player) => player.lossScore < GAME_END_LOSS_SCORE)) {
    return [];
  }
  const lowest = Math.min(...state.players.map((player) => player.lossScore));
  return state.players
    .map((player, index) => ({ player, index }))
    .filter(({ player }) => player.lossScore === lowest)
    .map(({ index }) => index);
};

const settle = (state: GameState): GameState => {
  const next = cloneState(state);
  let collected: Card[] = [];
  next.players.forEach((player) => {
    collected = collected.concat(player.negativeCards);
    player.lossScore += player.negativeCards.length;
    player.negativeCards = [];
  });
  next.settlementCount += 1;
  const winners = winnerIndexes(next);
  if (winners.length) {
    next.phase = "game_over";
    next.cardsPlayedThisTurn = 0;
    next.winners = winners;
    next.lastTurnPlayCounts = updatedLastTurnCounts(state);
    return next;
  }
  [collected, next.randomState] = shuffled(collected, next.randomState);
  next.deck = collected;
  next.currentPlayerIndex =
    (state.currentPlayerIndex + 1) % state.players.length;
  next.phase = "play";
  next.cardsPlayedThisTurn = 0;
  next.lastTurnPlayCounts = updatedLastTurnCounts(state);
  return next;
};

const applyRefill = (state: GameState, action: RefillAction): GameState => {
  const next = cloneState(state);
  const player = next.players[next.currentPlayerIndex];
  if (action.source === "deck") {
    player.hand.push(...draw(next.deck, Math.max(0, HAND_SIZE - player.hand.length)));
  } else if (action.source === "negative_cards") {
    [player.negativeCards, next.randomState] = shuffled(
      player.negativeCards,
      next.randomState,
    );
    player.hand.push(...draw(player.negativeCards, HAND_SIZE));
  }
  player.hand = sortHand(player.hand);
  if (action.source === "deck" && next.deck.length === 0) {
    return settle(next);
  }
  return advance(next);
};

export const placeActions = (state: GameState): PlaceCardAction[] =>
  legalActions(state).filter(
    (action): action is PlaceCardAction => action.type === "place",
  );

export const refillActions = (state: GameState): RefillAction[] =>
  legalActions(state).filter(
    (action): action is RefillAction => action.type === "refill",
  );
