import csv
import json
import statistics
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from scripts import gpu_benchmark as benchmark


class BenchmarkStatisticsTests(unittest.TestCase):
    def test_percentile_interpolates_between_samples(self):
        self.assertEqual(benchmark._percentile([1, 2, 3, 4], 0.5), 2.5)
        self.assertEqual(benchmark._percentile([], 0.5), None)

    def test_confidence_interval_is_centered_and_defined_for_one_sample(self):
        interval = benchmark._confidence_interval_95([10, 12, 14])
        self.assertLess(interval["low"], 12)
        self.assertGreater(interval["high"], 12)
        self.assertEqual(benchmark._confidence_interval_95([7]), {"low": 7, "high": 7})

    def test_large_sample_interval_uses_t_critical_above_normal_approximation(self):
        values = [float(value) for value in range(32)]
        interval = benchmark._confidence_interval_95(values)
        normal_half_width = 1.96 * statistics.stdev(values) / (len(values) ** 0.5)
        self.assertGreater(interval["high"] - 15.5, normal_half_width)
        self.assertAlmostEqual(benchmark._t_critical_95(31), 2.0395, places=3)

    def test_balanced_order_alternates_first_and_last_configs(self):
        self.assertEqual(
            benchmark._balanced_config_order([0, 10, 20, 30, 40]),
            [0, 40, 10, 30, 20],
        )

    def test_run_inference_rejects_missing_or_zero_token_usage(self):
        class Response:
            def __init__(self, payload):
                self.payload = payload
                self.status = 200

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self):
                return json.dumps(self.payload).encode("utf-8")

        for payload in (
            {"usage": {"prompt_tokens": 4}},
            {"usage": {"prompt_tokens": 4, "completion_tokens": 0}},
            {"usage": {"prompt_tokens": 0, "completion_tokens": 2}},
        ):
            with self.subTest(payload=payload), mock.patch.object(
                benchmark.urllib.request, "urlopen", return_value=Response(payload)
            ):
                result = benchmark.run_inference(8123)
                self.assertIsNotNone(result["error"])
                self.assertNotIn("tokens_per_sec", result)

    def test_health_requires_our_live_process_to_own_port(self):
        class Process:
            pid = 456

            def poll(self):
                return None

        with (
            mock.patch.object(benchmark, "_port_owned_by_process", return_value=False),
            mock.patch.object(benchmark.time, "sleep"),
            mock.patch.object(benchmark.urllib.request, "urlopen") as urlopen,
        ):
            self.assertFalse(benchmark.wait_for_server(8123, Process(), timeout=2))
            urlopen.assert_not_called()

    def test_health_is_accepted_only_after_port_identity_checks(self):
        class Process:
            pid = 456

            def poll(self):
                return None

        class Response:
            status = 200

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

        with (
            mock.patch.object(benchmark, "_port_owned_by_process", return_value=True) as owns_port,
            mock.patch.object(benchmark.urllib.request, "urlopen", return_value=Response()),
        ):
            self.assertTrue(benchmark.wait_for_server(8123, Process(), timeout=2))
        self.assertEqual(owns_port.call_count, 2)

    def test_run_summary_includes_latency_and_throughput_statistics(self):
        summary = benchmark._summarize_runs([
            {"elapsed_s": 2.0, "tokens_per_sec": 20, "ms_per_token": 50},
            {"elapsed_s": 4.0, "tokens_per_sec": 10, "ms_per_token": 100},
            {"elapsed_s": 3.0, "tokens_per_sec": 15, "ms_per_token": 75},
        ])
        self.assertEqual(summary["median_tokens_per_sec"], 15)
        self.assertEqual(summary["latency_p50_s"], 3)
        self.assertEqual(summary["latency_p95_s"], 3.9)
        self.assertEqual(summary["latency_p99_s"], 3.98)
        self.assertIn("throughput_ci95", summary)

    def test_failed_warmup_is_recorded_without_becoming_a_measurement(self):
        class Process:
            pid = 456

            def poll(self):
                return None

        results = iter([
            {"error": "missing token usage", "elapsed_s": 0.1},
            {"error": "response has zero completion token usage", "elapsed_s": 0.2},
            {
                "error": None,
                "elapsed_s": 1.0,
                "prompt_tokens": 4,
                "completion_tokens": 8,
                "tokens_per_sec": 8.0,
                "ms_per_token": 125.0,
            },
        ])
        with mock.patch.object(benchmark, "start_server", return_value=(Process(), None)), \
                mock.patch.object(benchmark, "wait_for_server", return_value=True), \
                mock.patch.object(benchmark, "run_inference", side_effect=lambda *a, **k: next(results)), \
                mock.patch.object(benchmark, "_process_memory_bytes", return_value={"rss_bytes": 100, "vms_bytes": 200}), \
                mock.patch.object(benchmark, "stop_server"):
            summary = benchmark.benchmark_gpu_layers(
                "bin", "/tmp/demo.gguf", gpu_configs=[0], warmup_runs=1, bench_runs=2
            )
        result = summary["results"][0]
        self.assertEqual(result["warmup_results"][0]["status"], "failed")
        self.assertEqual(result["warmup_results"][0]["error"], "missing token usage")
        self.assertEqual(len(result["runs"]), 1)
        self.assertEqual(result["rejected_runs"][0]["error"], "response has zero completion token usage")
        self.assertIn("hardware", summary)
        self.assertIsNone(summary["hardware"]["gpu_model"])
        self.assertIn("No cross-platform GPU discovery", summary["hardware"]["gpu_model_unavailable_reason"])
        self.assertIn("runtime", summary)

    def test_csv_html_and_baseline_reports(self):
        summary = {
            "model": "demo<&>",
            "timestamp_utc": "2026-01-01T00:00:00+00:00",
            "best_config": {"avg_tokens_per_sec": 12.0},
            "results": [{
                "gpu_layers": 10,
                "label": "GPU-10",
                "avg_tokens_per_sec": 12.0,
                "median_tokens_per_sec": 12.0,
                "throughput_ci95": {"low": 11.0, "high": 13.0},
                "avg_latency_s": 1.0,
                "latency_p50_s": 1.0,
                "latency_p95_s": 1.0,
                "latency_p99_s": 1.0,
                "peak_rss_bytes": 100,
                "peak_vms_bytes": 200,
                "warmup_results": [{"warmup": 1, "status": "failed", "error": "missing usage"}],
                "rejected_runs": [{"run": 1, "error": "missing usage"}],
                "runs": [],
            }],
        }
        with tempfile.TemporaryDirectory() as temp_dir:
            csv_path = Path(temp_dir) / "report.csv"
            html_path = Path(temp_dir) / "report.html"
            baseline_path = Path(temp_dir) / "baseline.json"
            baseline_path.write_text(json.dumps({"provider": "ollama", "avg_tokens_per_sec": 10.0}))
            benchmark.write_csv_report(summary, str(csv_path))
            benchmark.write_html_report(summary, str(html_path))
            compared = benchmark.compare_baseline(dict(summary), str(baseline_path))
            with csv_path.open(newline="", encoding="utf-8") as report_file:
                row = next(csv.DictReader(report_file))
            self.assertEqual(row["throughput_ci95_low"], "11.0")
            self.assertIn("failed: missing usage", row["warmup_status"])
            self.assertIn("run 1: missing usage", row["rejected_runs"])
            self.assertEqual(compared["baseline_comparison"]["throughput_change_percent"], 20.0)
            self.assertIn("demo&lt;&amp;&gt;", html_path.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
