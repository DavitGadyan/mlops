"""summarize.py against a results tree shaped like the tools' documented output.

The shapes come from AIPerf's JSON export schema and lm-eval's results file, not
from a real run. The first real run is the real test of these parsers.
"""

import json
from pathlib import Path

import pytest

from summarize import summarize


def aiperf_export(tps: float, rps: float, ttft: float, itl: float, good: float = 1.0) -> str:
    def stats(p50: float) -> dict:
        return {"unit": "ms", "avg": p50, "p50": p50, "p99": p50 * 2}

    return json.dumps(
        {
            "time_to_first_token": stats(ttft),
            "inter_token_latency": stats(itl),
            "output_token_throughput": {"unit": "tokens/sec", "avg": tps},
            "request_throughput": {"unit": "requests/sec", "avg": rps},
            "goodput": {"unit": "requests/sec", "avg": rps * good},
            "good_request_fraction": {"unit": "ratio", "avg": good},
        }
    )


def write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)


@pytest.fixture
def root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    for name, value in {"ISL": "512", "OSL": "256", "SLO_TTFT_MS": "500", "SLO_ITL_MS": "50"}.items():
        monkeypatch.setenv(name, value)
    write(tmp_path / "engines/trtllm-fp8.env", "# comment\nTRTLLM_MODEL=/models/x\nTRTLLM_LABEL=TRT-LLM FP8\n")

    target = tmp_path / "results/raw/trtllm-fp8"
    write(target / "gpu.csv", "NVIDIA GeForce RTX 4090 Laptop GPU, 16376 MiB\n")
    write(target / "weights_kib.txt", str(8 * 2**20))
    write(target / "c16/profile_export_aiperf.json", aiperf_export(900, 3.5, 120, 18))
    write(target / "c1/profile_export_aiperf.json", aiperf_export(60, 0.23, 40, 16))
    write(target / "open/profile_export_aiperf.json", aiperf_export(600, 2.4, 90, 17, good=0.97))
    write(target / "open/rate_rps.txt", "2.45\n")
    write(
        target / "eval/qwen7b/results_2026-11-20T10-00-00.json",
        json.dumps(
            {
                "results": {
                    "gsm8k": {
                        "exact_match,strict-match": 0.1,
                        "exact_match,flexible-extract": 0.84,
                        "exact_match_stderr,flexible-extract": 0.016,
                    }
                },
                "n-samples": {"gsm8k": {"original": 1319, "effective": 500}},
            }
        ),
    )

    spec = tmp_path / "results/raw/spec"
    for draft, tps, tokens in ((0, 60, "0 0"), (4, 81, "1000 620")):
        write(spec / f"d{draft}_c1/profile_export_aiperf.json", aiperf_export(tps, 0.3, 40, 12))
        write(spec / f"d{draft}_c1/draft_tokens.txt", tokens)
    return tmp_path


def test_summary_has_what_the_ui_reads(root: Path):
    summary = summarize(root)

    assert summary["hardware"] == "NVIDIA GeForce RTX 4090 Laptop GPU, 16376 MiB"
    assert summary["slo"] == {"ttft_ms": 500.0, "itl_ms": 50.0}
    [target] = summary["targets"]  # the spec/ directory is not a target
    assert (target["id"], target["label"], target["weights_gib"]) == ("trtllm-fp8", "TRT-LLM FP8", 8.0)

    assert [row["concurrency"] for row in target["sweep"]] == [1, 16]  # numeric order, not "c1" < "c16" by luck
    assert target["sweep"][1] == {
        "concurrency": 16,
        "output_tps": 900,
        "goodput_rps": 3.5,
        "ttft_ms": {"p50": 120, "p99": 240},
        "itl_ms": {"p50": 18, "p99": 36},
    }
    assert target["open_loop"]["rate_rps"] == 2.45
    assert target["open_loop"]["within_slo"] == 0.97
    assert target["accuracy"] == {"task": "gsm8k", "n": 500, "score": 0.84, "stderr": 0.016}


def test_speedup_is_relative_to_the_run_without_speculation(root: Path):
    [point] = summarize(root)["spec_decode"]
    assert point == {"draft_len": 4, "concurrency": 1, "speedup": 81 / 60, "acceptance_rate": 0.62}


def test_a_unit_change_in_aiperf_is_an_error_not_a_wrong_chart(root: Path):
    export = root / "results/raw/trtllm-fp8/c1/profile_export_aiperf.json"
    run = json.loads(export.read_text())
    run["time_to_first_token"]["unit"] = "sec"
    export.write_text(json.dumps(run))
    with pytest.raises(AssertionError, match="expected ms"):
        summarize(root)
