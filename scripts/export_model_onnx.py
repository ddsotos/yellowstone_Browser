"""Export the single browser model with strict metadata and ONNX parity."""

from __future__ import annotations

import hashlib
import json
import os
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
RL_BUNDLE = ROOT.parent / "rl_bundle"
TOOLS = Path(os.environ.get("YELLOWSTONE_ONNX_TOOLS", ROOT / ".tools" / "py"))
sys.path.insert(0, str(TOOLS))
sys.path.insert(0, str(RL_BUNDLE / "src"))

import numpy as np  # noqa: E402
import onnx  # noqa: E402
import torch  # noqa: E402
from onnx.reference import ReferenceEvaluator  # noqa: E402

from yellowstone.cnn import (  # noqa: E402
    build_win_value_net,
    win_value_architecture_from_checkpoint,
)
from yellowstone.value_board_columns import (  # noqa: E402
    BOARD_COLUMNS_CHANNELS,
    BOARD_COLUMNS_CONTEXT_SIZE,
    BOARD_COLUMNS_HEIGHT,
    BOARD_COLUMNS_WIDTH,
    CANONICALIZATION_BOARD_COLUMNS_V1,
)
from yellowstone.value_board_centered import (  # noqa: E402
    BOARD_CENTERED_BOARD_CHANNELS,
    BOARD_CENTERED_BOARD_SIZE,
    BOARD_CENTERED_V1_CONTEXT_SIZE,
    BOARD_CENTERED_V1_HISTORY_NONE,
)
from yellowstone.value_learning import VALUE_CONTEXT_SIZE  # noqa: E402


MODELS = (
    {
        "id": "v1-board-centered-explore-none-76919-epoch001",
        "label": "b-center V1 explore none 76,919 epoch001",
        "checkpoint": "win_value_v1_board_centered_explore_76919_none_epoch001.pt",
        "schema": "yellowstone.value.v1",
        "canonicalization": BOARD_CENTERED_V1_HISTORY_NONE,
        "history": "none",
        "channels": BOARD_CENTERED_BOARD_CHANNELS,
        "board_size": BOARD_CENTERED_BOARD_SIZE,
        "context": BOARD_CENTERED_V1_CONTEXT_SIZE,
        "score_kind": "probability",
        "output_transform": "sigmoid",
        "candidate_grouping": "played_cards",
    },
    {
        "id": "v1-6h-snapshot-canonical-epoch001",
        "label": "Canonical V1 6h snapshot epoch001",
        "checkpoint": "v2_heuristic_safe_counts_rank_color_6h_snapshot_training_canonical_epoch001_pct100.pt",
        "schema": "yellowstone.value.v1",
        "canonicalization": "fast_lr_ud_color_v1",
        "history": "rolling_last_two_placements",
        "channels": 29,
        "context": VALUE_CONTEXT_SIZE,
        "score_kind": "probability",
        "output_transform": "sigmoid",
        "candidate_grouping": "played_cards",
        "selection": {
            "selectionSource": "results\\evaluations\\v2_heuristic_safe_counts_rank_color_6h_snapshot_training_canonical_seat0_1000.json",
            "seat0Games": 1000,
            "seat0WinRate": 0.2915,
            "seat0OneCardTurnRate": 0.42116934393423117,
        },
    },
    {
        "id": "v1-6h-snapshot-board-columns-v1-epoch001",
        "label": "Board columns V1 6h snapshot epoch001",
        "checkpoint": "v2_heuristic_safe_counts_rank_color_6h_snapshot_training_board_columns_v1_epoch001_pct100.pt",
        "schema": "yellowstone.value.v1",
        "canonicalization": CANONICALIZATION_BOARD_COLUMNS_V1,
        "history": "none",
        "channels": BOARD_COLUMNS_CHANNELS,
        "board_height": BOARD_COLUMNS_HEIGHT,
        "board_width": BOARD_COLUMNS_WIDTH,
        "context": BOARD_COLUMNS_CONTEXT_SIZE,
        "score_kind": "probability",
        "output_transform": "sigmoid",
        "candidate_grouping": "played_cards",
        "selection": {
            "selectionSource": "results\\evaluations\\v2_heuristic_safe_counts_rank_color_6h_snapshot_training_board_columns_v1_1000_all_seats.json",
            "allSeatsGames": 4000,
            "allSeatsWinRate": 0.29458333333333336,
            "allSeatsOneCardTurnRate": 0.45545041842148443,
        },
    },
)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def build_model(checkpoint: dict, spec: dict):
    architecture = win_value_architecture_from_checkpoint(checkpoint)
    return build_win_value_net(
        context_size=int(checkpoint.get("context_size", spec["context"])),
        convolution_layers=int(architecture["convolution_layers"]),
        hidden_channels=int(architecture["hidden_channels"]),
        hidden_size=int(architecture["hidden_size"]),
        board_channels=int(architecture.get("board_channels", spec["channels"])),
        board_size=int(architecture.get("board_size", 7)),
        board_height=int(architecture.get("board_height", spec["board_height"])),
        board_width=int(architecture.get("board_width", spec["board_width"])),
    )


def export_one(spec: dict, output_dir: Path) -> dict:
    checkpoint_path = RL_BUNDLE / "models" / spec["checkpoint"]
    checkpoint = torch.load(checkpoint_path, map_location="cpu", weights_only=False)
    expected = {
        "value_schema": spec["schema"],
        "input_canonicalization": spec["canonicalization"],
        "history_semantics": spec["history"],
    }
    for key, value in expected.items():
        if checkpoint.get(key) != value:
            raise RuntimeError(
                f"{checkpoint_path.name}: {key}={checkpoint.get(key)!r}, expected {value!r}"
            )
    if int(checkpoint.get("context_size", spec["context"])) != spec["context"]:
        raise RuntimeError(f"{checkpoint_path.name}: context size mismatch")

    model = build_model(checkpoint, spec)
    model.load_state_dict(checkpoint["state_dict"])
    model.eval()

    generator = torch.Generator().manual_seed(20260730)
    board = torch.rand(
        (
            2,
            spec["channels"],
            spec["board_height"],
            spec["board_width"],
        ),
        generator=generator,
        dtype=torch.float32,
    )
    context = torch.rand((2, spec["context"]), generator=generator, dtype=torch.float32)
    output_path = output_dir / f"{spec['id']}.onnx"
    torch.onnx.export(
        model,
        (board, context),
        output_path,
        input_names=("board", "context"),
        output_names=("score",),
        dynamic_axes={
            "board": {0: "batch"},
            "context": {0: "batch"},
            "score": {0: "batch"},
        },
        opset_version=17,
        dynamo=False,
    )
    exported = onnx.load(output_path)
    onnx.checker.check_model(exported)
    evaluator = ReferenceEvaluator(exported)
    with torch.no_grad():
        expected_scores = model(board, context).numpy()
    (actual_scores,) = evaluator.run(
        None, {"board": board.numpy(), "context": context.numpy()}
    )
    max_difference = float(np.max(np.abs(expected_scores - np.asarray(actual_scores))))
    if max_difference > 2e-4:
        raise RuntimeError(
            f"{checkpoint_path.name}: ONNX parity failed ({max_difference})"
        )

    metadata = {
        "id": spec["id"],
        "label": spec["label"],
        "modelPath": f"models/{spec['id']}.onnx",
        "valueSchema": spec["schema"],
        "inputCanonicalization": spec["canonicalization"],
        "historySemantics": spec["history"],
        "featureContract": None,
        "boardChannels": spec["channels"],
        "boardSize": 7,
        "boardHeight": spec["board_height"],
        "boardWidth": spec["board_width"],
        "contextSize": spec["context"],
        "scoreKind": spec["score_kind"],
        "outputTransform": spec["output_transform"],
        "candidateGrouping": spec["candidate_grouping"],
        "sourceCheckpoint": f"rl_bundle/models/{checkpoint_path.name}",
        "sourceCheckpointSha256": sha256(checkpoint_path),
        "metrics": checkpoint.get("metrics", {}),
        "selection": spec["selection"],
        "exportMaxAbsoluteDifference": max_difference,
    }
    (output_dir / f"{spec['id']}.json").write_text(
        json.dumps(metadata, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return metadata


def main() -> None:
    output_dir = ROOT / "public" / "models"
    output_dir.mkdir(parents=True, exist_ok=True)
    registry = [export_one(spec, output_dir) for spec in MODELS]
    (output_dir / "registry.json").write_text(
        json.dumps({"schemaVersion": 1, "models": registry}, ensure_ascii=False, indent=2)
        + "\n",
        encoding="utf-8",
    )
    print(
        json.dumps(
            {
                "models": len(registry),
                "bytes": sum(
                    (output_dir / f"{row['id']}.onnx").stat().st_size
                    for row in registry
                ),
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
