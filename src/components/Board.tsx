import { Board as BoardState, Frame, PlaceCardAction, positionKey } from "../game/types";

const COLOR_LABEL = {
  red: "赤",
  blue: "青",
  green: "緑",
  yellow: "黄",
} as const;

interface Props {
  board: BoardState;
  legalPositionKeys?: Set<string>;
  frameAnchorKeys?: Set<string>;
  penaltyPositionKeys?: Set<string>;
  previewActions?: PlaceCardAction[];
  previewFrame?: Frame;
  onPositionClick?: (x: number, y: number) => void;
  onFrameAnchorClick?: (x: number, y: number) => void;
}

export function Board({
  board,
  legalPositionKeys = new Set(),
  frameAnchorKeys = new Set(),
  penaltyPositionKeys = new Set(),
  previewActions = [],
  previewFrame,
  onPositionClick,
  onFrameAnchorClick,
}: Props) {
  const xs = [6, 5, 4, 3, 2, 1, 0];
  const ys = [6, 5, 4, 3, 2, 1, 0];
  return (
    <div className="board-shell" aria-label="7×7のゲーム盤">
      <div className="rank-labels" aria-hidden="true">
        {ys.map((y) => (
          <span key={y}>{y + 1}</span>
        ))}
      </div>
      <div className="board">
        {ys.flatMap((y) =>
          xs.map((x) => {
            const key = positionKey({ x, y });
            const stack = board[key] ?? [];
            const top = stack.at(-1);
            const previewIndex = previewActions.findIndex(
              (action) => positionKey(action.position) === key,
            );
            const insideFrame =
              previewFrame &&
              x >= previewFrame.x &&
              x < previewFrame.x + 3 &&
              y >= previewFrame.y &&
              y < previewFrame.y + 3;
            const isFrameAnchor = frameAnchorKeys.has(key);
            const isPlacementTarget = legalPositionKeys.has(key);
            const isPenalty = penaltyPositionKeys.has(key);
            return (
              <button
                type="button"
                key={key}
                className={[
                  "board-cell",
                  isPlacementTarget ? "is-legal" : "",
                  isFrameAnchor ? "is-frame-anchor" : "",
                  insideFrame ? "in-frame" : "",
                  isPenalty ? "will-be-penalty" : "",
                ].join(" ")}
                onClick={() =>
                  isFrameAnchor
                    ? onFrameAnchorClick?.(x, y)
                    : onPositionClick?.(x, y)
                }
                disabled={!isPlacementTarget && !isFrameAnchor}
                aria-label={`${y + 1}行 ${7 - x}列${
                  top ? ` ${COLOR_LABEL[top.color]}${top.rankIndex + 1}` : ""
                }`}
              >
                {top && (
                  <span className={`board-card card-${top.color}`}>
                    <span className="card-color">{COLOR_LABEL[top.color]}</span>
                    <strong>{top.rankIndex + 1}</strong>
                    {stack.length > 1 && <small>×{stack.length}</small>}
                  </span>
                )}
                {previewIndex >= 0 && (
                  <span className="play-order">{previewIndex + 1}</span>
                )}
                {isPenalty && <span className="penalty-label">失点</span>}
                {isFrameAnchor && <span className="frame-anchor-label">左上</span>}
              </button>
            );
          }),
        )}
      </div>
      <div className="column-labels" aria-hidden="true">
        {xs.map((x) => (
          <span key={x}>{7 - x}</span>
        ))}
      </div>
    </div>
  );
}
