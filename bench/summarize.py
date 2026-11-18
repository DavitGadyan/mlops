"""Collect raw AIPerf and lm-eval output into results/summary.json, the one file the UI reads.

    python bench/summarize.py        (normally via `make summary`)
"""

import json
import os
from datetime import datetime, timezone
from pathlib import Path

REFERENCE = "vllm-bf16"  # accuracy deltas are measured against the unquantized model


def load(path: Path) -> dict:
    return json.loads(path.read_text())


def latency(run: dict) -> dict:
    """Time to first token and inter-token latency from one AIPerf run."""

    def tail(metric: str) -> dict:
        # Fail loudly if AIPerf ever changes units, instead of charting seconds as milliseconds.
        assert run[metric]["unit"] == "ms", f"{metric} is in {run[metric]['unit']}, expected ms"
        return {"p50": run[metric]["p50"], "p99": run[metric]["p99"]}

    return {"ttft_ms": tail("time_to_first_token"), "itl_ms": tail("inter_token_latency")}


def sweep(target: Path) -> list[dict]:
    rows = []
    for export in target.glob("c*/profile_export_aiperf.json"):
        run = load(export)
        rows.append(
            {
                "concurrency": int(export.parent.name[1:]),
                "output_tps": run["output_token_throughput"]["avg"],
                "goodput_rps": run["goodput"]["avg"],
                **latency(run),
            }
        )
    return sorted(rows, key=lambda row: row["concurrency"])


def open_loop(target: Path) -> dict | None:
    export = target / "open/profile_export_aiperf.json"
    if not export.exists():
        return None
    run = load(export)
    return {
        "rate_rps": float((target / "open/rate_rps.txt").read_text()),
        "within_slo": run["good_request_fraction"]["avg"],
        **latency(run),
    }


def accuracy(target: Path) -> dict | None:
    reports = sorted(target.glob("eval/**/results_*.json"))
    if not reports:
        return None
    report = load(reports[-1])  # file names carry a timestamp, so the last is the newest
    scores = report["results"]["gsm8k"]
    # flexible-extract scores the last number in the answer. strict-match wants the
    # dataset's own "#### 42" format, which a chat model does not reliably produce.
    return {
        "task": "gsm8k",
        "n": report["n-samples"]["gsm8k"]["effective"],
        "score": scores["exact_match,flexible-extract"],
        "stderr": scores["exact_match_stderr,flexible-extract"],
    }


def spec_decode(raw: Path) -> list[dict]:
    """Speed-up and draft acceptance per (draft length, concurrency); draft length 0 is the baseline."""
    runs = {}
    for export in raw.glob("spec/d*_c*/profile_export_aiperf.json"):
        draft, concurrency = (int(part[1:]) for part in export.parent.name.split("_"))
        drafted, accepted = map(int, (export.parent / "draft_tokens.txt").read_text().split())
        runs[draft, concurrency] = (load(export)["output_token_throughput"]["avg"], drafted, accepted)
    return [
        {
            "draft_len": draft,
            "concurrency": concurrency,
            "speedup": tps / runs[0, concurrency][0],
            "acceptance_rate": accepted / drafted if drafted else 0.0,
        }
        for (draft, concurrency), (tps, drafted, accepted) in sorted(runs.items())
        if draft and (0, concurrency) in runs
    ]


def summarize(root: Path) -> dict:
    raw = root / "results/raw"
    targets, hardware = [], "unknown GPU"
    for target in sorted(raw.iterdir()):
        env = root / "engines" / f"{target.name}.env"
        if not env.exists():  # results/raw/spec is not a target
            continue
        label = next(line.split("=", 1)[1] for line in env.read_text().splitlines() if "_LABEL=" in line)
        entry = {"id": target.name, "label": label, "sweep": sweep(target)}
        if (target / "gpu.csv").exists():
            hardware = (target / "gpu.csv").read_text().strip()
            entry["weights_gib"] = int((target / "weights_kib.txt").read_text()) / 2**20
        for key, value in (("open_loop", open_loop(target)), ("accuracy", accuracy(target))):
            if value:
                entry[key] = value
        targets.append(entry)

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "hardware": hardware,
        "workload": f"synthetic prompts, {os.environ['ISL']} input / {os.environ['OSL']} output tokens",
        "slo": {"ttft_ms": float(os.environ["SLO_TTFT_MS"]), "itl_ms": float(os.environ["SLO_ITL_MS"])},
        "reference": REFERENCE,
        "targets": targets,
        "spec_decode": spec_decode(raw),
    }


if __name__ == "__main__":
    summary = summarize(Path("."))
    Path("results/summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(f"results/summary.json: {len(summary['targets'])} targets, {len(summary['spec_decode'])} speculative runs")
