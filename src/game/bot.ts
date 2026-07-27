import {
  applyKnownLegalAction,
  boardEntries,
  framePositions,
  legalActions,
} from "./game";
import {
  Action,
  Board,
  Card,
  Color,
  GameState,
  PlaceCardAction,
  positionKey,
} from "./types";

const lexicographicCompare = (left: number[], right: number[]): number => {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference) return difference;
  }
  return 0;
};

const negativeDelta = (state: GameState, action: PlaceCardAction): number => {
  const inside = new Set(framePositions(action.frame).map(positionKey));
  return Object.entries(state.board)
    .filter(([key]) => !inside.has(key))
    .reduce((total, [, stack]) => total + stack.length, 0);
};

const occupiedCount = (board: Board, action: PlaceCardAction): number => {
  const inside = new Set(framePositions(action.frame).map(positionKey));
  return Object.keys(board).filter((key) => inside.has(key)).length;
};

const positiveDelta = (state: GameState, action: PlaceCardAction): number => {
  const before = occupiedCount(state.board, action);
  if (positionKey(action.position) in state.board) return 0;
  const after = before + 1;
  if (before < 8 && after >= 8) return 1;
  if (before < 9 && after >= 9) return 3;
  return 0;
};

const boardColorCount = (board: Board, color: Color): number =>
  boardEntries(board).reduce(
    (total, [, stack]) =>
      total + stack.filter((card) => card.color === color).length,
    0,
  );

const sameColorRemaining = (
  hand: Card[],
  playedIndex: number,
  color: Color,
): number =>
  hand.filter((card, index) => index !== playedIndex && card.color === color)
    .length;

export const placementSortKey = (
  state: GameState,
  action: PlaceCardAction,
): number[] => {
  const player = state.players[state.currentPlayerIndex];
  const card = player.hand[action.handIndex];
  return [
    negativeDelta(state, action),
    -positiveDelta(state, action),
    -Math.abs(card.rankIndex - 3),
    positionKey(action.position) in state.board ? 0 : 1,
    -sameColorRemaining(player.hand, action.handIndex, card.color),
    -boardColorCount(state.board, card.color),
    action.handIndex,
    action.position.x,
    action.position.y,
    action.frame.x,
    action.frame.y,
  ];
};

const bestPlacement = (
  state: GameState,
  actions: PlaceCardAction[],
): PlaceCardAction | undefined =>
  [...actions].sort((a, b) =>
    lexicographicCompare(placementSortKey(state, a), placementSortKey(state, b)),
  )[0];

const noDamage = (
  state: GameState,
  actions: PlaceCardAction[],
): PlaceCardAction[] => actions.filter((action) => negativeDelta(state, action) === 0);

const chooseRefill = (state: GameState, actions: Action[]): Action | undefined => {
  const player = state.players[state.currentPlayerIndex];
  if (
    !player.hand.length &&
    player.negativeCards.length >= 6 &&
    actions.some(
      (action) => action.type === "refill" && action.source === "negative_cards",
    )
  ) {
    return { type: "refill", source: "negative_cards" };
  }
  return (
    actions.find(
      (action) => action.type === "refill" && action.source === "deck",
    ) ?? actions[0]
  );
};

export const chooseHeuristicAction = (state: GameState): Action | undefined => {
  const actions = legalActions(state);
  if (!actions.length || state.phase === "game_over") return undefined;
  const refills = actions.filter((action) => action.type === "refill");
  if (state.phase === "refill" || refills.length) {
    return chooseRefill(state, refills);
  }
  const placements = actions.filter(
    (action): action is PlaceCardAction => action.type === "place",
  );
  if (!placements.length) {
    return actions.find((action) => action.type === "end_turn");
  }
  if (state.cardsPlayedThisTurn === 0) {
    const safe = noDamage(state, placements);
    return bestPlacement(state, safe.length ? safe : placements);
  }
  const safe = noDamage(state, placements);
  if (safe.length) return bestPlacement(state, safe);
  const positive = placements.filter((action) => positiveDelta(state, action) > 0);
  if (positive.length) return bestPlacement(state, positive);
  return (
    actions.find((action) => action.type === "end_turn") ??
    bestPlacement(state, placements)
  );
};

export const playHeuristicTurn = (
  initialState: GameState,
): { state: GameState; actions: Action[] } => {
  const playerIndex = initialState.currentPlayerIndex;
  let state = initialState;
  const actions: Action[] = [];
  while (
    state.phase !== "game_over" &&
    state.currentPlayerIndex === playerIndex
  ) {
    const action = chooseHeuristicAction(state);
    if (!action) break;
    actions.push(action);
    state = applyKnownLegalAction(state, action);
  }
  return { state, actions };
};
