"""Dashboard JSON adapter; imports the supplied demo helpers and trained model."""
import hashlib
import json
import os
import sys

MODEL_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "model")
sys.path.insert(0, MODEL_DIR)
from demo.server import MODEL, ctx, explain, meta  # noqa: E402


def execute(request):
    action = request["action"]
    if action == "meta":
        result = meta()
        with open(os.path.join(MODEL_DIR, "amr_model.json"), "rb") as handle:
            result["model_id"] = hashlib.sha256(handle.read()).hexdigest()
        result["training"] = {key: MODEL.meta.get(key) for key in ("source", "trained_on", "n_isolates", "aware_note")}
        return result
    inputs = request["inputs"]
    if action == "predict":
        result = {"empiric": MODEL.empiric_coverage(inputs["specimen"], top_k=3, **ctx(inputs)), "resistance": None}
        if inputs.get("organism"):
            result["resistance"] = MODEL.predict_resistance(
                inputs["organism"], inputs["specimen"], top_k=3,
                known_results=inputs.get("known_results"), flags=inputs.get("flags"), **ctx(inputs)
            )
        return result
    if action == "explain":
        return explain(inputs)
    raise ValueError("Unknown action")


if __name__ == "__main__":
    try:
        print(json.dumps(execute(json.load(sys.stdin)), allow_nan=False))
    except Exception as error:
        print(json.dumps({"error": str(error)}))
        sys.exit(1)
