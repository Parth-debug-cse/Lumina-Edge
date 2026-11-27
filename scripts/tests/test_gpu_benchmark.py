import csv
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import gpu_benchmark as benchmark


class BenchmarkStatisticsTests(unittest.TestCase):
    def test_percentile_interpolates_between_samples(self):
        self.assertEqual(benchmark._percentile([1, 2, 3, 4], 0.5), 2.5)
        self.assertEqual(benchmark._percentile([], 0.5), None)

    def test_confidence_interval_is_centered_and_defined_for_one_sample(self):
        interval = benchmark._confidence_interval_95([10, 12, 14])
        self.assertLess(interval["low"], 12)
        self.assertGreater(interval["high"], 12)
        self.assertEqual(benchmark._confidence_interval_95([7]), {"low": 7, "high": 7})

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
            self.assertEqual(compared["baseline_comparison"]["throughput_change_percent"], 20.0)
            self.assertIn("demo&lt;&amp;&gt;", html_path.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
