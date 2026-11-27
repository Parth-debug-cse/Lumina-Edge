#!/usr/bin/env python3
"""Repeatable MLX baseline-versus-speculative decoding benchmark."""

from __future__ import annotations

import argparse
import contextlib
import importlib.metadata
import io
import json
import math
import os
import platform
import statistics
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any



def percentile(values: list[float], quantile: float) -> float | None:
    if not values:
        return None
    if not 0.0 <= quantile <= 1.0:
        raise ValueError("quantile must be between 0 and 1")
    ordered = sorted(values)
    position = (len(ordered) - 1) * quantile
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return ordered[lower]
    fraction = position - lower
    return ordered[lower] + (ordered[upper] - ordered[lower]) * fraction


def _t_critical_95(degrees_of_freedom: int) -> float:
    """Two-sided 95% Student-t critical value (Cornish-Fisher for df > 30)."""
    table = [
        0.0, 12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262,
        2.228, 2.201, 2.179, 2.160, 2.145, 2.131, 2.120, 2.110, 2.101, 2.093,
        2.086, 2.080, 2.074, 2.069, 2.064, 2.060, 2.056, 2.052, 2.048, 2.045,
        2.042,
    ]
    if degrees_of_freedom < len(table):
        return table[degrees_of_freedom]
    # Standard asymptotic expansion around z=1.959964; accurate to <0.001
    # for df > 30, rather than substituting the normal critical value.
    z = 1.959963984540054
    z2 = z * z
    z3 = z2 * z
    z5 = z3 * z2
    z7 = z5 * z2
    df = float(degrees_of_freedom)
    return (z + (z3 + z) / (4 * df)
            + (5 * z5 + 16 * z3 + 3 * z) / (96 * df ** 2)
            + (3 * z7 + 19 * z5 + 17 * z3 - 15 * z) / (384 * df ** 3))


def confidence_interval_95(values: list[float]) -> dict[str, float | None]:
    if not values:
        return {"low": None, "high": None}
    mean = statistics.mean(values)
    if len(values) == 1:
        return {"low": mean, "high": mean}
    degrees_of_freedom = len(values) - 1
    critical = _t_critical_95(degrees_of_freedom)
    half_width = critical * statistics.stdev(values) / math.sqrt(len(values))
    return {"low": mean - half_width, "high": mean + half_width}


def paired_speedup_summary(
    baseline_trials: list[dict[str, Any]], speculative_trials: list[dict[str, Any]]
) -> dict[str, Any]:
    if len(baseline_trials) != len(speculative_trials) or not baseline_trials:
        raise ValueError("paired comparisons require equal, non-empty trial sets")
    ratios = []
    for baseline, speculative in zip(baseline_trials, speculative_trials):
        baseline_tps = float(baseline["tokens_per_second"])
        if baseline_tps <= 0:
            raise ValueError("baseline throughput must be positive")
        ratios.append(float(speculative["tokens_per_second"]) / baseline_tps)
    ratio_ci = confidence_interval_95(ratios)
    low = ratio_ci["low"]
    high = ratio_ci["high"]
    if low is None or high is None:
        raise ValueError("paired speedup confidence interval is undefined")
    gain_ci = {
        "low": (low - 1.0) * 100.0,
        "high": (high - 1.0) * 100.0,
    }
    mean_ratio = statistics.mean(ratios)
    return {
        "paired_iterations": len(ratios),
        "mean_paired_speedup": mean_ratio,
        "paired_speedup_ci95": ratio_ci,
        "mean_paired_gain_percent": (mean_ratio - 1.0) * 100.0,
        "paired_gain_percent_ci95": gain_ci,
    }


def summarize_trials(trials: list[dict[str, Any]]) -> dict[str, Any]:
    if not trials:
        raise ValueError("cannot summarize an empty benchmark sample")
    throughput = [float(trial["tokens_per_second"]) for trial in trials]
    latency = [float(trial["generation_seconds"]) for trial in trials]
    ttft = [float(trial["time_to_first_token_seconds"]) for trial in trials]
    output_tokens = [int(trial["output_tokens"]) for trial in trials]
    accepted = [int(trial["accepted_draft_tokens"]) for trial in trials]
    confidence = confidence_interval_95(throughput)
    p50 = percentile(latency, 0.50)
    p95 = percentile(latency, 0.95)
    p99 = percentile(latency, 0.99)
    ttft_p50 = percentile(ttft, 0.50)
    if None in (p50, p95, p99, ttft_p50):
        raise ValueError("latency percentiles require at least one sample")
    token_total = sum(output_tokens)
    return {
        "iterations": len(trials),
        "mean_tokens_per_second": statistics.mean(throughput),
        "median_tokens_per_second": statistics.median(throughput),
        "tokens_per_second_ci95_mean": confidence,
        "mean_generation_seconds": statistics.mean(latency),
        "generation_latency_p50_seconds": p50,
        "generation_latency_p95_seconds": p95,
        "generation_latency_p99_seconds": p99,
        "time_to_first_token_p50_seconds": ttft_p50,
        "mean_output_tokens": statistics.mean(output_tokens),
        "accepted_draft_tokens": sum(accepted),
        "draft_acceptance_rate": (sum(accepted) / token_total) if token_total else None,
        "trials": trials,
    }


def _positive_int(value: str) -> int:
    number = int(value)
    if number < 1:
        raise argparse.ArgumentTypeError("value must be at least 1")
    return number


def _non_negative_int(value: str) -> int:
    number = int(value)
    if number < 0:
        raise argparse.ArgumentTypeError("value must be zero or greater")
    return number


def _system_chip_name() -> str | None:
    if platform.system() != "Darwin":
        return platform.processor() or None
    try:
        result = subprocess.run(
            ["sysctl", "-n", "machdep.cpu.brand_string"],
            check=True,
            capture_output=True,
            text=True,
            timeout=3,
        )
        return result.stdout.strip() or None
    except (OSError, subprocess.SubprocessError):
        return platform.processor() or None


def _package_version(name: str) -> str | None:
    try:
        return importlib.metadata.version(name)
    except importlib.metadata.PackageNotFoundError:
        return None


def _model_arrays(model: Any) -> list[Any]:
    from mlx.utils import tree_flatten

    return [array for _, array in tree_flatten(model.parameters())]


def _memory_snapshot(mx: Any, process: Any) -> dict[str, int | None]:
    try:
        metal_active = int(mx.get_active_memory())
    except Exception:
        metal_active = None
    try:
        metal_peak = int(mx.get_peak_memory())
    except Exception:
        metal_peak = None
    return {
        "process_rss_bytes": int(process.memory_info().rss),
        "metal_active_bytes": metal_active,
        "metal_peak_bytes": metal_peak,
    }


def _run_trial(
    backend: Any,
    mx: Any,
    mode: str,
    model: Any,
    tokenizer: Any,
    prompt: str,
    max_tokens: int,
    speculative_draft: dict[str, Any] | None,
) -> dict[str, Any]:
    import psutil

    config = backend.load_config()
    config["temperature"] = 0.0
    config["top_p"] = 1.0
    config["min_p"] = 0.0
    config["repeat_penalty"] = 1.0
    config["mlx_sampling"] = {
        "temperature": 0.0,
        "top_p": 1.0,
        "min_p": 0.0,
        "repetition_penalty": 1.0,
        "repetition_context_size": 20,
        "max_tokens": max_tokens,
    }
    generation_kwargs = backend.get_mlx_generation_kwargs(
        config,
        prompt=prompt,
        override_temp=0.0,
        override_top_p=1.0,
        override_max_tokens=max_tokens,
    )
    if mode != "configured_baseline":
        for key in (
            "kv_bits", "key_bits", "value_bits", "kv_group_size",
            "quantized_kv_start", "max_kv_size",
        ):
            generation_kwargs.pop(key, None)
    generation_kwargs.update({"model": model, "tokenizer": tokenizer})

    mx.reset_peak_memory()
    start = time.perf_counter()
    first_token_time = None
    output_tokens = 0
    accepted_draft_tokens = 0
    output_parts: list[str] = []
    fallback_log = io.StringIO()
    draft_supported = getattr(backend, "_supports_draft_model", True)
    backend_fallback = mode == "speculative" and (
        not speculative_draft or draft_supported is False
    )

    def consume(generator):
        nonlocal first_token_time, output_tokens, accepted_draft_tokens
        for response in generator:
            now = time.perf_counter()
            generated = int(getattr(response, "generation_tokens", output_tokens))
            if generated > output_tokens:
                if first_token_time is None:
                    first_token_time = now - start
                if bool(getattr(response, "from_draft", False)):
                    accepted_draft_tokens += generated - output_tokens
                output_tokens = generated
            text = getattr(response, "text", "")
            if text:
                output_parts.append(text)

    if mode == "speculative":
        # mlx_backend reports its TypeError fallback on stdout. Capture the log
        # while consuming the lazy generator so it cannot silently enter results.
        with contextlib.redirect_stdout(fallback_log):
            generator = backend._stream_generate(generation_kwargs, speculative_draft)
            consume(generator)
        fallback_text = fallback_log.getvalue().strip()
        backend_fallback = backend_fallback or "using normal generation" in fallback_text.casefold()
    else:
        consume(backend._stream_generate(generation_kwargs, None))
        fallback_text = ""
    generation_seconds = time.perf_counter() - start
    if output_tokens <= 0:
        if backend_fallback:
            raise RuntimeError(
                f"speculative backend fell back to normal decoding and produced no output tokens: {fallback_text}"
            )
        raise RuntimeError(f"{mode} produced no output tokens")
    if first_token_time is None:
        if backend_fallback:
            raise RuntimeError(
                f"speculative backend fell back to normal decoding without a first-token time: {fallback_text}"
            )
        raise RuntimeError(f"{mode} did not report a first-token time")
    memory = _memory_snapshot(mx, psutil.Process())
    return {
        "mode": mode,
        "output_tokens": output_tokens,
        "generation_seconds": generation_seconds,
        "tokens_per_second": output_tokens / generation_seconds,
        "time_to_first_token_seconds": first_token_time,
        "accepted_draft_tokens": accepted_draft_tokens,
        "backend_fallback": backend_fallback,
        "backend_fallback_reason": fallback_text if backend_fallback else None,
        "output_text": "".join(output_parts),
        **memory,
    }


def run_benchmark(args: argparse.Namespace) -> dict[str, Any]:
    if platform.system() != "Darwin" or platform.machine() != "arm64":
        raise RuntimeError("This benchmark requires Apple Silicon with MLX installed")
    target_path = Path(args.model).expanduser().resolve()
    draft_path = Path(args.draft_model).expanduser().resolve()
    for label, path in (("target", target_path), ("draft", draft_path)):
        if not path.is_dir() or not (path / "config.json").is_file():
            raise FileNotFoundError(f"{label} model must be a local MLX model directory: {path}")

    import mlx.core as mx
    import mlx_lm
    import psutil
    backend_module = f"{__package__}.mlx_backend" if __package__ else "mlx_backend"
    backend = importlib.import_module(backend_module)

    process = psutil.Process()
    available_ram_before_load = psutil.virtual_memory().available
    memory_before = _memory_snapshot(mx, process)
    load_start = time.perf_counter()
    model, tokenizer = backend._load_mlx_model_and_tokenizer(str(target_path))
    mx.eval(*_model_arrays(model))
    target_load_seconds = time.perf_counter() - load_start
    memory_after_target = _memory_snapshot(mx, process)

    draft_config = backend.load_config()
    draft_config["mlx_speculative_decoding"] = {
        "enabled": True,
        "draft_model": str(draft_path),
        "num_draft_tokens": args.num_draft_tokens,
    }
    draft_load_start = time.perf_counter()
    speculative_draft = backend._load_speculative_draft(draft_config, tokenizer)
    if speculative_draft is None:
        raise RuntimeError("Draft model failed to load or its tokenizer is incompatible")
    mx.eval(*_model_arrays(speculative_draft["model"]))
    draft_load_seconds = time.perf_counter() - draft_load_start
    memory_after_draft = _memory_snapshot(mx, process)

    prompt_messages = [{
        "role": "user",
        "content": "Explain in one paragraph how speculative decoding can reduce language-model inference latency.",
    }]
    prompt = tokenizer.apply_chat_template(
        prompt_messages, tokenize=False, add_generation_prompt=True
    )
    configured_benchmark = backend.load_config()
    configured_benchmark["temperature"] = 0.0
    configured_benchmark["top_p"] = 1.0
    configured_generation_kwargs = backend.get_mlx_generation_kwargs(
        configured_benchmark,
        prompt=prompt,
        override_temp=0.0,
        override_top_p=1.0,
        override_max_tokens=args.max_tokens,
    )
    cache_option_names = (
        "kv_bits", "key_bits", "value_bits", "kv_group_size",
        "quantized_kv_start", "max_kv_size",
    )
    configured_cache_options = {
        name: configured_generation_kwargs[name]
        for name in cache_option_names
        if name in configured_generation_kwargs
    }

    modes = ("configured_baseline", "matched_baseline", "speculative")
    warmups: dict[str, list[dict[str, Any]]] = {mode: [] for mode in modes}
    for round_index in range(args.warmup_rounds):
        order = modes if round_index % 2 == 0 else tuple(reversed(modes))
        for mode in order:
            try:
                result = _run_trial(
                    backend, mx, mode, model, tokenizer, prompt,
                    args.max_tokens, speculative_draft,
                )
                status = "rejected_backend_fallback" if result.get("backend_fallback") else "ok"
                warmup = {
                    "status": status,
                    "output_tokens": result["output_tokens"],
                    "tokens_per_second": result["tokens_per_second"],
                }
                if result.get("backend_fallback_reason"):
                    warmup["error"] = result["backend_fallback_reason"]
            except Exception as exc:
                warmup = {"status": "failed", "error": str(exc)}
            warmups[mode].append(warmup)
        print(f"Completed warmup {round_index + 1}/{args.warmup_rounds}", flush=True)

    measured: dict[str, list[dict[str, Any]]] = {mode: [] for mode in modes}
    text_match_counts = {mode: 0 for mode in modes}
    rejected_measured_iterations = []
    for iteration in range(args.iterations):
        order = modes if iteration % 2 == 0 else tuple(reversed(modes))
        current: dict[str, dict[str, Any]] = {}
        iteration_errors = []
        for mode in order:
            try:
                result = _run_trial(
                    backend, mx, mode, model, tokenizer, prompt,
                    args.max_tokens, speculative_draft,
                )
            except Exception as exc:
                iteration_errors.append({"mode": mode, "error": str(exc)})
                continue
            current[mode] = result
            if result.get("backend_fallback"):
                iteration_errors.append({
                    "mode": mode,
                    "error": result.get("backend_fallback_reason") or "backend fell back to normal decoding",
                })
        if iteration_errors:
            rejected_measured_iterations.append({
                "iteration": iteration + 1,
                "reasons": iteration_errors,
            })
            print(f"Rejected measured iteration {iteration + 1}: {iteration_errors}", flush=True)
            continue

        reference_text = current["configured_baseline"]["output_text"]
        for mode in modes:
            text_match_counts[mode] += current[mode]["output_text"] == reference_text
            measured[mode].append({
                key: value for key, value in current[mode].items() if key != "output_text"
            })
        print(f"Completed measured iteration {iteration + 1}/{args.iterations}", flush=True)

    if not measured["speculative"]:
        raise RuntimeError(
            "No valid paired measured iterations remained; speculative fallback or trial failures were rejected"
        )
    summaries = {mode: summarize_trials(trials) for mode, trials in measured.items()}
    comparisons = {
        f"speculative_vs_{baseline}": paired_speedup_summary(
            measured[baseline], measured["speculative"]
        )
        for baseline in ("configured_baseline", "matched_baseline")
    }

    try:
        repository_revision = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=Path(__file__).resolve().parents[1],
            check=True,
            capture_output=True,
            text=True,
            timeout=3,
        ).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        repository_revision = None

    total_memory = psutil.virtual_memory().total
    target_name = target_path.parent.parent.name if target_path.parent.name == "snapshots" else target_path.name
    draft_name = draft_path.parent.parent.name if draft_path.parent.name == "snapshots" else draft_path.name
    target_revision = target_path.name if target_path.parent.name == "snapshots" else None
    draft_revision = draft_path.name if draft_path.parent.name == "snapshots" else None
    return {
        "schema_version": 1,
        "benchmark": "mlx_target_vs_speculative_draft",
        "timestamp_utc": datetime.now(timezone.utc).isoformat(),
        "measurement_scope": "single Apple Silicon machine; results are hardware- and model-specific",
        "hardware": {
            "chip": _system_chip_name(),
            "machine": platform.machine(),
            "os": platform.platform(),
            "physical_cpu_count": psutil.cpu_count(logical=False),
            "logical_cpu_count": psutil.cpu_count(logical=True),
            "total_ram_bytes": total_memory,
            "available_ram_before_load_bytes": available_ram_before_load,
        },
        "software": {
            "python": platform.python_version(),
            "mlx": _package_version("mlx"),
            "mlx_lm": _package_version("mlx-lm"),
            "repository_revision": repository_revision,
        },
        "models": {
            "target": {"name": target_name, "revision": target_revision},
            "draft": {"name": draft_name, "revision": draft_revision},
            "num_draft_tokens": args.num_draft_tokens,
            "target_load_seconds": target_load_seconds,
            "draft_load_seconds": draft_load_seconds,
        },
        "conditions": {
            "configured_baseline": "Project MLX config with its effective KV-cache options retained.",
            "matched_baseline": "Same greedy generation settings with explicit KV-cache options removed.",
            "speculative": "Matched baseline plus the configured local draft model and draft-token count.",
            "configured_baseline_effective_kv_options": configured_cache_options,
        },
        "workload": {
            "prompt": prompt_messages[0]["content"],
            "max_tokens": args.max_tokens,
            "temperature": 0.0,
            "warmup_rounds_per_mode": args.warmup_rounds,
            "iterations_per_mode": args.iterations,
            "valid_paired_iterations": len(measured["speculative"]),
            "order": "alternating forward/reverse mode order per round",
        },
        "memory": {
            "before_model_load": memory_before,
            "after_target_load": memory_after_target,
            "after_draft_load": memory_after_draft,
            "note": "Per-trial MLX peak includes resident target and draft weights in all modes; RSS also includes the Python/MLX runtime.",
        },
        "warmup_results_excluded_from_statistics": warmups,
        "rejected_measured_iterations": rejected_measured_iterations,
        "results": summaries,
        "comparison": {
            **comparisons,
            "output_exact_match_fraction_vs_configured_baseline": {
                mode: text_match_counts[mode] / len(measured["speculative"]) for mode in modes
            },
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", required=True, help="Local MLX target-model directory")
    parser.add_argument("--draft-model", required=True, help="Local tokenizer-compatible MLX draft-model directory")
    parser.add_argument("--warmup-rounds", type=_non_negative_int, default=2)
    parser.add_argument("--iterations", type=_positive_int, default=7)
    parser.add_argument("--max-tokens", type=_positive_int, default=128)
    parser.add_argument("--num-draft-tokens", type=_positive_int, default=2)
    parser.add_argument("--json-output", help="Write full results to this JSON file")
    args = parser.parse_args()

    if args.num_draft_tokens > 16:
        parser.error("--num-draft-tokens must be at most 16")
    report = run_benchmark(args)
    output = json.dumps(report, indent=2, ensure_ascii=False) + "\n"
    if args.json_output:
        output_path = Path(args.json_output).expanduser()
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(output, encoding="utf-8")
        print(f"JSON report: {output_path}")
        print(json.dumps(report["comparison"], indent=2))
    else:
        print(output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
