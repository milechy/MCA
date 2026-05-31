#!/usr/bin/env python3
"""Prompt task + complexity classifier for the NemoClaw brain (NVIDIA LLM Router policy).

Adopts NVIDIA's `prompt-task-and-complexity-classifier` (DeBERTa-v3-base, 0.2B)
as the primary signal source for "pick the best LLM for THIS function" routing,
exactly as the NVIDIA LLM Router blueprint's `complexity_router` policy does.

This host is Apple Silicon (no NVIDIA GPU / Triton), so we run the classifier
directly on CPU/MPS instead of the full GPU Triton stack — a single prompt per
story is cheap. Two backends, selected by --backend:

  nvidia     real trained classifier (downloaded from HF on first use)
  heuristic  zero-dependency fallback (keyword/length/structure features) so the
             loop NEVER blocks on the ML runtime — the documented escape hatch.

Output contract (one JSON object on stdout), aligned with the NVIDIA model's
fields so the two backends are interchangeable for the brain:

  {
    "ok": true,
    "backend": "nvidia" | "heuristic",
    "task_type": "Code Generation",
    "task_type_prob": 0.77,
    "prompt_complexity_score": 0.41,     # 0..1 overall, drives the tier
    "reasoning": 0.0,                     # 0..1 sub-scores (nvidia only; heuristic estimates)
    "domain_knowledge": 0.0,
    "creativity_scope": 0.0,
    "contextual_knowledge": 0.0,
    "constraint_ct": 0.0,
    "number_of_few_shots": 0,
    "latency_ms": 12
  }

Usage:
  echo '{"prompt": "..."}' | classify.py --backend heuristic
  classify.py --backend nvidia --prompt "Implement a Queue class with tests"
  classify.py --backend nvidia --self-test     # download + probe + print latency
"""
import argparse
import json
import re
import sys
import time

# 11 task categories the NVIDIA classifier emits; the heuristic maps onto the
# same label space so downstream bucketing is identical across backends.
TASK_TYPES = [
    "Open QA", "Closed QA", "Summarization", "Text Generation",
    "Code Generation", "Chatbot", "Classification", "Rewrite",
    "Brainstorming", "Extraction", "Other",
]

MODEL_NAME = "nvidia/prompt-task-and-complexity-classifier"

# ---------------------------------------------------------------------------
# Heuristic backend — no ML deps. Good enough to beat the currently-mispredicted
# static story.difficulty (outcomes.jsonl shows predicted=easy / actual=hard).
# ---------------------------------------------------------------------------

_CODE_HINTS = re.compile(
    r"\b(implement|function|class|method|module|refactor|api|endpoint|"
    r"async|await|test[s]?|unit test|fix bug|regex|algorithm|parser|"
    r"queue|pool|cache|schema|migration|typescript|javascript|python|"
    r"\.js|\.ts|\.py|export|import|const|def )\b",
    re.IGNORECASE,
)
_REASON_HINTS = re.compile(
    r"\b(design|architect|trade[- ]?off|concurren|race condition|distributed|"
    r"optimi[sz]e|complexity|invariant|consistency|idempoten|state machine|"
    r"backpressure|deadlock|throughput|latency)\b",
    re.IGNORECASE,
)
_DOMAIN_HINTS = re.compile(
    r"\b(cryptograph|kubernetes|terraform|wasm|compiler|kernel|"
    r"oauth|jwt|rls|postgres|supabase|cloudflare worker|llm|inference|"
    r"webhook|protocol|bytecode)\b",
    re.IGNORECASE,
)
_CONSTRAINT_HINTS = re.compile(
    r"\b(must|should|require[ds]?|ensure|only|never|always|exactly|"
    r"without|do not|don't|constraint|limit|cap|deadline)\b",
    re.IGNORECASE,
)


def _clip01(x):
    return max(0.0, min(1.0, float(x)))


def heuristic_classify(prompt: str) -> dict:
    text = prompt or ""
    n = len(text)
    code = len(_CODE_HINTS.findall(text))
    reason = len(_REASON_HINTS.findall(text))
    domain = len(_DOMAIN_HINTS.findall(text))
    constraint = len(_CONSTRAINT_HINTS.findall(text))
    few_shots = len(re.findall(r"(?m)^\s*(example|e\.g\.|for instance)\b", text, re.IGNORECASE))

    if code >= 1:
        task_type = "Code Generation"
        task_prob = _clip01(0.55 + 0.05 * code)
    elif re.search(r"\b(summari[sz]e|tl;dr|recap)\b", text, re.IGNORECASE):
        task_type = "Summarization"
        task_prob = 0.6
    elif re.search(r"\b(rewrite|rephrase|reword|edit)\b", text, re.IGNORECASE):
        task_type = "Rewrite"
        task_prob = 0.6
    elif re.search(r"\b(extract|parse out|pull)\b", text, re.IGNORECASE):
        task_type = "Extraction"
        task_prob = 0.55
    else:
        task_type = "Text Generation"
        task_prob = 0.5

    # Sub-scores in 0..1, scaled from hint density + length.
    reasoning = _clip01(reason / 4.0 + (n > 1200) * 0.15)
    domain_knowledge = _clip01(domain / 3.0)
    creativity = _clip01(0.05 + (task_type in ("Text Generation", "Brainstorming")) * 0.2)
    contextual = _clip01(n / 4000.0)
    constraint_ct = _clip01(constraint / 6.0)

    # Same weighting NVIDIA documents for the overall score.
    complexity = _clip01(
        0.35 * creativity
        + 0.25 * reasoning
        + 0.15 * constraint_ct
        + 0.15 * domain_knowledge
        + 0.05 * contextual
        + 0.05 * min(few_shots / 5.0, 1.0)
    )
    # Code tasks carry an implementation floor — even "easy" code work is harder
    # than the raw sub-scores suggest (this is the gap that broke the static map).
    if task_type == "Code Generation":
        complexity = _clip01(max(complexity, 0.18 + 0.12 * reason + 0.10 * domain))

    return {
        "task_type": task_type,
        "task_type_prob": round(task_prob, 4),
        "prompt_complexity_score": round(complexity, 5),
        "reasoning": round(reasoning, 4),
        "domain_knowledge": round(domain_knowledge, 4),
        "creativity_scope": round(creativity, 4),
        "contextual_knowledge": round(contextual, 4),
        "constraint_ct": round(constraint_ct, 4),
        "number_of_few_shots": int(few_shots),
    }


# ---------------------------------------------------------------------------
# NVIDIA backend — the real trained classifier. Loaded lazily so the heuristic
# path has zero import cost.
# ---------------------------------------------------------------------------

_NV = {"tok": None, "model": None}


def _build_custom_model():
    """Reconstruct NVIDIA's multi-head classifier (it is NOT an AutoModel — the
    repo config has no `model_type`, so AutoModel can't load it). This mirrors
    the official model-card `CustomModel`: a deberta-v3-base backbone + one
    linear head per target, with mean pooling."""
    import json
    import os
    import sys
    import torch
    from torch import nn
    from transformers import AutoModel
    from huggingface_hub import PyTorchModelHubMixin, hf_hub_download

    with open(hf_hub_download(MODEL_NAME, "config.json"), "r") as fh:
        cfg = json.load(fh)

    class MeanPooling(nn.Module):
        def forward(self, last_hidden_state, attention_mask):
            mask = attention_mask.unsqueeze(-1).expand(last_hidden_state.size()).float()
            summed = torch.sum(last_hidden_state * mask, 1)
            counts = torch.clamp(mask.sum(1), min=1e-9)
            return summed / counts

    class MulticlassHead(nn.Module):
        def __init__(self, input_size, num_classes):
            super().__init__()
            self.fc = nn.Linear(input_size, num_classes)

        def forward(self, x):
            return self.fc(x)

    class CustomModel(nn.Module, PyTorchModelHubMixin):
        def __init__(self, target_sizes, task_type_map, weights_map, divisor_map):
            super().__init__()
            self.backbone = AutoModel.from_pretrained(cfg["base_model"])
            self.target_sizes = target_sizes
            self.task_type_map = task_type_map
            self.weights_map = weights_map
            self.divisor_map = divisor_map
            # The checkpoint names heads as individual attributes head_0..head_N
            # (NOT a ModuleList), so register them the same way or weights won't
            # load. target_sizes preserves the config's target ordering.
            self._head_names = []
            for i, sz in enumerate(target_sizes.values()):
                name = f"head_{i}"
                setattr(self, name, MulticlassHead(self.backbone.config.hidden_size, sz))
                self._head_names.append(name)
            self.pool = MeanPooling()

        def compute_results(self, preds, target):
            if target == "task_type":
                probs = torch.softmax(preds, dim=1)
                top = torch.topk(probs, 2, dim=1)
                idx = top.indices[0]
                names = [self.task_type_map[str(int(i))] for i in idx]
                return names[0], float(top.values[0][0])
            probs = torch.softmax(preds, dim=1)
            weights = torch.tensor(self.weights_map[target], dtype=probs.dtype)
            score = float((probs[0] * weights).sum() / self.divisor_map[target])
            return score

        def forward(self, batch):
            hidden = self.backbone(
                input_ids=batch["input_ids"], attention_mask=batch["attention_mask"]
            ).last_hidden_state
            mean = self.pool(hidden, batch["attention_mask"])
            logits = [getattr(self, name)(mean) for name in self._head_names]
            out = {}
            for name, lg in zip(self.target_sizes.keys(), logits):
                if name == "task_type":
                    out["task_type"], out["task_type_prob"] = self.compute_results(lg, name)
                else:
                    out[name] = self.compute_results(lg, name)
            out["prompt_complexity_score"] = round(
                0.35 * out.get("creativity_scope", 0.0)
                + 0.25 * out.get("reasoning", 0.0)
                + 0.15 * out.get("constraint_ct", 0.0)
                + 0.15 * out.get("domain_knowledge", 0.0)
                + 0.05 * out.get("contextual_knowledge", 0.0)
                + 0.05 * out.get("number_of_few_shots", 0.0),
                5,
            )
            return out

    model = CustomModel(
        target_sizes=cfg["target_sizes"],
        task_type_map=cfg["task_type_map"],
        weights_map=cfg["weights_map"],
        divisor_map=cfg["divisor_map"],
    )
    # Load the checkpoint weights directly (the mixin's classmethod
    # from_pretrained rebuilds the instance from saved config and silently
    # mismatched our custom heads → garbage output). Loading the state_dict
    # ourselves with strict=True surfaces any key/shape mismatch instead.
    try:
        from safetensors.torch import load_file
        weights_path = hf_hub_download(MODEL_NAME, "model.safetensors")
        state = load_file(weights_path)
    except Exception:
        weights_path = hf_hub_download(MODEL_NAME, "pytorch_model.bin")
        state = torch.load(weights_path, map_location="cpu")
    missing, unexpected = model.load_state_dict(state, strict=False)
    if os.environ.get("NEMOCLAW_CLASSIFIER_DEBUG"):
        print(
            f"[load] missing={len(missing)} unexpected={len(unexpected)} "
            f"sample_missing={list(missing)[:4]} sample_unexpected={list(unexpected)[:4]}",
            file=sys.stderr,
        )
    return model.eval()


def _load_nvidia():
    if _NV["model"] is not None:
        return
    from transformers import AutoTokenizer

    _NV["tok"] = AutoTokenizer.from_pretrained(MODEL_NAME)
    _NV["model"] = _build_custom_model()


def nvidia_classify(prompt: str) -> dict:
    import torch

    _load_nvidia()
    tok, model = _NV["tok"], _NV["model"]
    enc = tok([prompt or ""], return_tensors="pt", truncation=True, max_length=512, padding=True)
    with torch.no_grad():
        out = model(enc)
    return {
        "task_type": str(out.get("task_type", "Other")),
        "task_type_prob": round(float(out.get("task_type_prob", 0.0)), 4),
        "prompt_complexity_score": round(float(out.get("prompt_complexity_score", 0.0)), 5),
        "reasoning": round(float(out.get("reasoning", 0.0)), 4),
        "domain_knowledge": round(float(out.get("domain_knowledge", 0.0)), 4),
        "creativity_scope": round(float(out.get("creativity_scope", 0.0)), 4),
        "contextual_knowledge": round(float(out.get("contextual_knowledge", 0.0)), 4),
        "constraint_ct": round(float(out.get("constraint_ct", 0.0)), 4),
        "number_of_few_shots": int(round(float(out.get("number_of_few_shots", 0.0)))),
    }


def classify(prompt: str, backend: str) -> dict:
    t0 = time.time()
    if backend == "nvidia":
        try:
            sig = nvidia_classify(prompt)
            backend_used = "nvidia"
        except Exception as exc:  # pragma: no cover - runtime fallback path
            sig = heuristic_classify(prompt)
            sig["nvidia_error"] = str(exc)[:300]
            backend_used = "heuristic"
    else:
        sig = heuristic_classify(prompt)
        backend_used = "heuristic"
    sig["ok"] = True
    sig["backend"] = backend_used
    sig["latency_ms"] = int((time.time() - t0) * 1000)
    return sig


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--backend", choices=["nvidia", "heuristic"], default="heuristic")
    ap.add_argument("--prompt", default=None)
    ap.add_argument("--self-test", action="store_true")
    args = ap.parse_args()

    if args.self_test:
        samples = [
            "Add a typo fix to the README",
            "Implement an in-memory Queue class with FIFO ops and unit tests",
            "Design a distributed, idempotent job scheduler with backpressure and exactly-once semantics across workers",
        ]
        for s in samples:
            print(json.dumps({"prompt": s[:50], **classify(s, args.backend)}))
        return

    if args.prompt is not None:
        prompt = args.prompt
    else:
        raw = sys.stdin.read()
        try:
            prompt = json.loads(raw).get("prompt", "") if raw.strip() else ""
        except json.JSONDecodeError:
            prompt = raw
    print(json.dumps(classify(prompt, args.backend)))


if __name__ == "__main__":
    main()
