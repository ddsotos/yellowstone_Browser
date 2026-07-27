"""Export the canonical Yellowstone win-value model for browser inference."""

from __future__ import annotations

import json
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
BUNDLE = ROOT.parent / "online_bundle"
TOOLS = ROOT / ".tools" / "py"
sys.path.insert(0, str(TOOLS))
sys.path.insert(0, str(BUNDLE / "src"))

import onnx  # noqa: E402
import torch  # noqa: E402
from onnx.reference import ReferenceEvaluator  # noqa: E402

from yellowstone.cnn import build_win_value_net  # noqa: E402
from yellowstone.value_learning import (  # noqa: E402
    RANK_BOARD_CHANNELS,
    VALUE_CONTEXT_SIZE,
)


def main() -> None:
    checkpoint_path = BUNDLE / "models" / "win_value_canonical_old_001.pt"
    output_dir = ROOT / "public" / "models"
    output_dir.mkdir(parents=True, exist_ok=True)
    output_path = output_dir / "win_value.onnx"

    checkpoint = torch.load(checkpoint_path, map_location="cpu", weights_only=False)
    canonicalization = checkpoint.get("input_canonicalization")
    if canonicalization != "fast_lr_ud_color_v1":
        raise RuntimeError(
            f"unsupported input canonicalization: {canonicalization!r}"
        )
    model = build_win_value_net()
    model.load_state_dict(checkpoint["state_dict"])
    model.eval()

    board = torch.zeros((2, RANK_BOARD_CHANNELS, 7, 7), dtype=torch.float32)
    context = torch.zeros((2, VALUE_CONTEXT_SIZE), dtype=torch.float32)
    torch.onnx.export(
        model,
        (board, context),
        output_path,
        input_names=("board", "context"),
        output_names=("logit",),
        dynamic_axes={
            "board": {0: "batch"},
            "context": {0: "batch"},
            "logit": {0: "batch"},
        },
        opset_version=17,
        dynamo=False,
    )
    exported = onnx.load(output_path)
    onnx.checker.check_model(exported)
    evaluator = ReferenceEvaluator(exported)
    with torch.no_grad():
        expected = model(board, context).numpy()
    (actual,) = evaluator.run(
        None,
        {"board": board.numpy(), "context": context.numpy()},
    )
    max_difference = float(abs(expected - actual).max())
    if max_difference > 1e-5:
        raise RuntimeError(f"ONNX parity check failed: {max_difference}")

    metadata = {
        "modelVersion": "canonical-old-001",
        "source": "../online_bundle/models/win_value_canonical_old_001.pt",
        "inputCanonicalization": canonicalization,
        "metrics": checkpoint.get("metrics", {}),
        "boardShape": ["batch", RANK_BOARD_CHANNELS, 7, 7],
        "contextShape": ["batch", VALUE_CONTEXT_SIZE],
        "output": "sigmoid(logit)",
        "exportMaxAbsoluteDifference": max_difference,
    }
    (output_dir / "win_value.json").write_text(
        json.dumps(metadata, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"exported {output_path} ({output_path.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
