"""Export every browser analysis model with strict metadata and ONNX parity."""

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

from yellowstone.action_delta import (  # noqa: E402
    ACTION_DELTA_CONTEXT_SIZE,
    CANONICALIZATION_ACTION_DELTA,
    HISTORY_SEMANTICS_ACTION_DELTA,
    VALUE_SCHEMA_ACTION_DELTA,
    build_action_delta_net,
)
from yellowstone.privileged_state import (  # noqa: E402
    CANONICALIZATION_PRIVILEGED_STATE,
    FEATURE_CONTRACT_PRIVILEGED_STATE,
    HISTORY_SEMANTICS_PRIVILEGED_STATE,
)
from yellowstone.cnn import (  # noqa: E402
    build_win_value_net,
    build_win_value_net_v2,
    build_win_value_net_v2_lite,
    win_value_architecture_from_checkpoint,
)
from yellowstone.value_learning import VALUE_CONTEXT_SIZE  # noqa: E402
from yellowstone.value_board_centered import (  # noqa: E402
    BOARD_CENTERED_BOARD_CHANNELS,
    BOARD_CENTERED_BOARD_SIZE,
    BOARD_CENTERED_V1_CONTEXT_SIZE,
    BOARD_CENTERED_V1_HISTORY_NONE,
)
from yellowstone.value_board_columns import (  # noqa: E402
    BOARD_COLUMNS_CHANNELS,
    BOARD_COLUMNS_CONTEXT_SIZE,
    BOARD_COLUMNS_HEIGHT,
    BOARD_COLUMNS_WIDTH,
    CANONICALIZATION_BOARD_COLUMNS_V1,
)
from yellowstone.value_board_columns_v2 import (  # noqa: E402
    CANONICALIZATION_PREPLAY_BOARD_COLUMNS,
    PREPLAY_BOARD_COLUMNS_CONTEXT_SIZE,
    VALUE_SCHEMA_PREPLAY_BOARD_COLUMNS,
)
from yellowstone.value_v2 import (  # noqa: E402
    BOARD_CHANNELS_V2,
    VALUE_CONTEXT_SIZE_V2,
)
from yellowstone.value_v2_lite import (  # noqa: E402
    BOARD_CHANNELS_V2_LITE,
    CANONICALIZATION_V2_LITE,
    VALUE_CONTEXT_SIZE_V2_LITE,
    VALUE_SCHEMA_V2_LITE,
)


MODELS = (
    {
        "id": "preplay-v1-current",
        "label": "Pre-play V1 current (privileged preview)",
        "checkpoint": "preplay_v1_current_epoch001.pt",
        "schema": "yellowstone.value.privileged-state.v1",
        "canonicalization": CANONICALIZATION_PRIVILEGED_STATE,
        "history": HISTORY_SEMANTICS_PRIVILEGED_STATE,
        "channels": 29,
        "context": 190,
        "score_kind": "probability",
        "output_transform": "softmax_player0",
        "candidate_grouping": "played_cards",
        "builder": "privileged",
    },
    {
        "id": "preplay-safe-counts-generation0-197800-epoch001",
        "label": "Pre-play board columns 6h snapshot epoch001",
        "checkpoint": "v2_heuristic_safe_counts_rank_color_6h_snapshot_training_preplay_board_columns_epoch001.pt",
        "schema": VALUE_SCHEMA_PREPLAY_BOARD_COLUMNS,
        "canonicalization": CANONICALIZATION_PREPLAY_BOARD_COLUMNS,
        "history": "last_two_completed_turns_before_turn",
        "channels": 1,
        "board_height": 7,
        "board_width": 3,
        "context": PREPLAY_BOARD_COLUMNS_CONTEXT_SIZE,
        "score_kind": "probability",
        "output_transform": "sigmoid",
        "candidate_grouping": "played_cards",
        "builder": "v1",
    },
    {
        "id": "v1-generation0-epoch002",
        "label": "Original V1 gen0 epoch002",
        "checkpoint": "win_value_v1_original_generation0_197800_epoch002.pt",
        "schema": "yellowstone.value.v1",
        "canonicalization": "fast_lr_ud_color_v1",
        "history": "rolling_last_two_placements",
        "channels": 29,
        "context": VALUE_CONTEXT_SIZE,
        "score_kind": "probability",
        "candidate_grouping": "played_cards",
        "builder": "v1",
    },
    {
        "id": "canonical-old-001",
        "label": "Canonical old 660k epoch001",
        "checkpoint": "win_value_canonical_old_001.pt",
        "schema": "yellowstone.value.v1",
        "canonicalization": "fast_lr_ud_color_v1",
        "history": "rolling_last_two_placements",
        "channels": 29,
        "context": VALUE_CONTEXT_SIZE,
        "score_kind": "probability",
        "candidate_grouping": "played_cards",
        "builder": "v1",
        "allow_legacy_contract": True,
    },
    {
        "id": "v2-generation0-epoch001",
        "label": "V2 gen0 epoch001",
        "checkpoint": "win_value_v2_generation0_197800_epoch001.pt",
        "schema": "yellowstone.value.v2",
        "canonicalization": "strict_residual_v2",
        "history": "last_three_completed_turns_before_turn",
        "channels": BOARD_CHANNELS_V2,
        "context": VALUE_CONTEXT_SIZE_V2,
        "score_kind": "probability",
        "candidate_grouping": "played_cards_and_refill",
        "builder": "v2",
    },
    {
        "id": "action-delta-selected",
        "label": "Action delta（公開情報）",
        "checkpoint": None,
        "label": "Action delta selected",
        "schema": VALUE_SCHEMA_ACTION_DELTA,
        "canonicalization": CANONICALIZATION_ACTION_DELTA,
        "history": HISTORY_SEMANTICS_ACTION_DELTA,
        "channels": BOARD_CHANNELS_V2_LITE,
        "context": ACTION_DELTA_CONTEXT_SIZE,
        "score_kind": "delta",
        "candidate_grouping": "played_cards",
        "builder": "action_delta",
    },
    {
        "id": "v1-new-88966-epoch001",
        "label": "Original V1 新88,966戦 epoch001",
        "checkpoint": "win_value_v1_original_new_88966_epoch001.pt",
        "label": "Original V1 new 88,966 games epoch001",
        "schema": "yellowstone.value.v1",
        "canonicalization": "fast_lr_ud_color_v1",
        "history": "rolling_last_two_placements",
        "channels": 29,
        "context": VALUE_CONTEXT_SIZE,
        "score_kind": "probability",
        "candidate_grouping": "played_cards",
        "builder": "v1",
    },
    {
        "id": "v1-exploratory-59826-epoch001",
        "label": "V1 explore 59,826戦 epoch001",
        "checkpoint": "win_value_v1_exploratory_59826_epoch001_pct100.pt",
        "schema": "yellowstone.value.v1",
        "canonicalization": "fast_lr_ud_color_v1",
        "history": "rolling_last_two_placements",
        "channels": 29,
        "context": VALUE_CONTEXT_SIZE,
        "score_kind": "probability",
        "candidate_grouping": "played_cards",
        "builder": "v1",
    },
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
        "candidate_grouping": "played_cards",
        "builder": "v1",
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
        "candidate_grouping": "played_cards",
        "builder": "v1",
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
        "candidate_grouping": "played_cards",
        "builder": "v1",
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


def selected_delta() -> tuple[str, dict]:
    summary_path = (
        RL_BUNDLE
        / "results/evaluations/action_delta_milestones_pct030_pct100_all_seats.json"
    )
    if not summary_path.exists():
        raise RuntimeError(
            "action-delta four-seat comparison is incomplete; refusing to guess"
        )
    summary = json.loads(summary_path.read_text(encoding="utf-8-sig"))
    if summary.get("status") != "complete":
        raise RuntimeError("action-delta four-seat comparison is not complete")
    rows = summary.get("milestones", [])
    if {int(row["percent"]) for row in rows} != {30, 100}:
        raise RuntimeError("action-delta comparison must contain 30% and 100%")
    selected = max(
        rows,
        key=lambda row: (
            float(row["all_seats_win_rate"]),
            -int(row["percent"]),
        ),
    )
    return Path(selected["checkpoint"]).name, {
        "selectionSource": str(summary_path.relative_to(RL_BUNDLE)),
        "selectedPercent": int(selected["percent"]),
        "allSeatsGames": int(selected["all_seats_games"]),
        "allSeatsWinRate": float(selected["all_seats_win_rate"]),
        "compared": [
            {
                "percent": int(row["percent"]),
                "allSeatsWinRate": float(row["all_seats_win_rate"]),
            }
            for row in rows
        ],
    }


def build_model(kind: str, checkpoint: dict, spec: dict):
    if kind == "v1":
        architecture = win_value_architecture_from_checkpoint(checkpoint)
        return build_win_value_net(
            context_size=int(checkpoint.get("context_size", VALUE_CONTEXT_SIZE)),
            convolution_layers=int(architecture["convolution_layers"]),
            hidden_channels=int(architecture["hidden_channels"]),
            hidden_size=int(architecture["hidden_size"]),
            board_channels=int(architecture.get("board_channels", spec["channels"])),
            board_size=int(architecture.get("board_size", spec.get("board_size", 7))),
            board_height=int(
                architecture.get(
                    "board_height",
                    architecture.get("board_size", spec.get("board_height", spec.get("board_size", 7))),
                )
            ),
            board_width=int(
                architecture.get(
                    "board_width",
                    architecture.get("board_size", spec.get("board_width", spec.get("board_size", 7))),
                )
            ),
        )
    if kind == "v2":
        return build_win_value_net_v2()
    if kind == "v2_lite":
        return build_win_value_net_v2_lite()
    if kind == "action_delta":
        return build_action_delta_net()
    if kind == "privileged":
        context_size = int(checkpoint.get("context_size", spec["context"]))

        class PrivilegedStateNet(torch.nn.Module):
            def __init__(self):
                super().__init__()
                self.board_encoder = torch.nn.Sequential(
                    torch.nn.Conv2d(29, 64, 3, padding=1),
                    torch.nn.ReLU(),
                    torch.nn.Conv2d(64, 64, 3, padding=1),
                    torch.nn.ReLU(),
                    torch.nn.Flatten(),
                )
                self.trunk = torch.nn.Sequential(
                    torch.nn.Linear(64 * 7 * 7 + context_size, 128),
                    torch.nn.ReLU(),
                )
                self.value_head = torch.nn.Linear(128, 4)

            def forward(self, board, context):
                encoded = self.board_encoder(board)
                return self.value_head(
                    self.trunk(torch.cat((encoded, context), dim=1))
                )

        class CurrentPlayerPrivileged(torch.nn.Module):
            def __init__(self):
                super().__init__()
                self.base = PrivilegedStateNet()

            def forward(self, board, context):
                return torch.softmax(self.base(board, context), dim=1)[:, 0]

        return CurrentPlayerPrivileged()
    raise AssertionError(f"unknown builder: {kind}")


def export_one(spec: dict, output_dir: Path, selection: dict | None) -> dict:
    checkpoint_path = RL_BUNDLE / "models" / spec["checkpoint"]
    checkpoint = torch.load(checkpoint_path, map_location="cpu", weights_only=False)
    expected = {
        "value_schema": spec["schema"],
        "input_canonicalization": spec["canonicalization"],
    }
    if spec["builder"] in {"v1", "action_delta", "privileged"}:
        expected["history_semantics"] = spec["history"]
    for key, value in expected.items():
        if checkpoint.get(key) != value and not spec.get("allow_legacy_contract"):
            raise RuntimeError(
                f"{checkpoint_path.name}: {key}={checkpoint.get(key)!r}, expected {value!r}"
            )
    if spec.get("feature_contract") is not None and checkpoint.get(
        "feature_contract"
    ) != spec["feature_contract"]:
        raise RuntimeError(
            f"{checkpoint_path.name}: feature_contract={checkpoint.get('feature_contract')!r}, "
            f"expected {spec['feature_contract']!r}"
        )
    if int(checkpoint.get("context_size", spec["context"])) != spec["context"]:
        raise RuntimeError(f"{checkpoint_path.name}: context size mismatch")
    if spec["builder"] == "action_delta" and checkpoint.get(
        "opponent_private_inputs"
    ) is not False:
        raise RuntimeError("action-delta must not use opponent private inputs")
    if spec["builder"] == "privileged" and checkpoint.get("privileged_inputs") is not True:
        raise RuntimeError("pre-play preview checkpoint must declare privileged inputs")

    model = build_model(spec["builder"], checkpoint, spec)
    if spec["builder"] == "privileged":
        model.base.load_state_dict(checkpoint["state_dict"])
    else:
        model.load_state_dict(checkpoint["state_dict"])
    model.eval()
    generator = torch.Generator().manual_seed(20260730)
    board = torch.rand(
        (
            2,
            spec["channels"],
            spec.get("board_height", spec.get("board_size", 7)),
            spec.get("board_width", spec.get("board_size", 7)),
        ),
        generator=generator,
        dtype=torch.float32,
    )
    context = torch.rand(
        (2, spec["context"]), generator=generator, dtype=torch.float32
    )
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
    max_difference = float(
        np.max(np.abs(expected_scores - np.asarray(actual_scores)))
    )
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
        "featureContract": spec.get("feature_contract"),
        "boardChannels": spec["channels"],
        "boardSize": spec.get("board_size", 7),
        "boardHeight": spec.get("board_height", spec.get("board_size", 7)),
        "boardWidth": spec.get("board_width", spec.get("board_size", 7)),
        "contextSize": spec["context"],
        "scoreKind": spec["score_kind"],
        "outputTransform": spec.get(
            "output_transform",
            "identity" if spec["score_kind"] == "delta" else "sigmoid",
        ),
        "candidateGrouping": spec["candidate_grouping"],
        "sourceCheckpoint": f"rl_bundle/models/{checkpoint_path.name}",
        "sourceCheckpointSha256": sha256(checkpoint_path),
        "metrics": checkpoint.get("metrics", {}),
        "selection": spec.get("selection", selection),
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
    delta_checkpoint, delta_selection = selected_delta()
    specs = [dict(spec) for spec in MODELS]
    for spec in specs:
        if spec["builder"] == "action_delta":
            spec["checkpoint"] = delta_checkpoint
    registry = [
        export_one(
            spec,
            output_dir,
            delta_selection if spec["builder"] == "action_delta" else None,
        )
        for spec in specs
    ]
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
