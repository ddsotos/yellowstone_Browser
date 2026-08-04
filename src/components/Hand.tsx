import { Card } from "../game/types";

const COLOR_LABEL = {
  red: "R",
  blue: "B",
  green: "G",
  yellow: "Y",
} as const;

interface Props {
  cards: Card[];
  selectedIndex: number | null;
  disabled?: boolean;
  onSelect: (index: number) => void;
}

export function Hand({ cards, selectedIndex, disabled, onSelect }: Props) {
  return (
    <div className="hand" aria-label="your hand">
      {cards.map((card, index) => (
        <button
          type="button"
          className={`hand-card card-${card.color} ${
            selectedIndex === index ? "selected" : ""
          }`}
          key={`${card.color}-${card.rankIndex}-${index}`}
          onClick={() => onSelect(index)}
          disabled={disabled}
          aria-pressed={selectedIndex === index}
        >
          <span>{COLOR_LABEL[card.color]}</span>
          <strong>{card.rankIndex + 1}</strong>
        </button>
      ))}
    </div>
  );
}
