import statistics
import sys
import types
import unittest
from unittest import mock

from scripts import mlx_speculative_benchmark as benchmark


class BenchmarkStatisticsTests(unittest.TestCase):
    def test_percentile_interpolates_between_observations(self):
        self.assertEqual(benchmark.percentile([1.0, 2.0, 3.0, 4.0, 5.0], 0.95), 4.8)

    def test_confidence_interval_is_centered_for_single_sample(self):
        self.assertEqual(benchmark.confidence_interval_95([12.0]), {"low": 12.0, "high": 12.0})

    def test_large_sample_interval_uses_t_critical_above_normal_approximation(self):
        values = [float(value) for value in range(32)]
        interval = benchmark.confidence_interval_95(values)
        normal_half_width = 1.96 * statistics.stdev(values) / (len(values) ** 0.5)
        high = interval["high"]
        self.assertIsNotNone(high)
        assert high is not None
        self.assertGreater(high - 15.5, normal_half_width)
        self.assertAlmostEqual(benchmark._t_critical_95(31), 2.0395, places=3)

    def test_speculative_fallback_is_marked_on_trial(self):
        class Response:
            generation_tokens = 2
            from_draft = False
            text = "normal decode"

        class Backend:
            _supports_draft_model = True

            @staticmethod
            def load_config():
                return {}

            @staticmethod
            def get_mlx_generation_kwargs(*_args, **_kwargs):
                return {}

            @staticmethod
            def _stream_generate(_kwargs, _draft):
                print("Speculative decoding arguments rejected; using normal generation")
                yield Response()

        mx = types.SimpleNamespace(reset_peak_memory=lambda: None)
        fake_psutil = types.SimpleNamespace(Process=lambda: object())
        with mock.patch.dict(sys.modules, {"psutil": fake_psutil}), mock.patch.object(
            benchmark, "_memory_snapshot", return_value={"process_rss_bytes": 1}
        ):
            trial = benchmark._run_trial(
                Backend(), mx, "speculative", object(), object(), "prompt", 8,
                {"model": object(), "num_tokens": 2},
            )
        self.assertTrue(trial["backend_fallback"])
        self.assertIn("using normal generation", trial["backend_fallback_reason"])

    def test_paired_speedup_reports_percent_gain_and_confidence_interval(self):
        baseline = [{"tokens_per_second": 100.0}, {"tokens_per_second": 100.0}]
        speculative = [{"tokens_per_second": 110.0}, {"tokens_per_second": 120.0}]

        comparison = benchmark.paired_speedup_summary(baseline, speculative)

        self.assertEqual(comparison["paired_iterations"], 2)
        self.assertEqual(comparison["mean_paired_speedup"], 1.15)
        self.assertAlmostEqual(comparison["mean_paired_gain_percent"], 15.0)
        self.assertLess(comparison["paired_gain_percent_ci95"]["low"], 15.0)
        self.assertGreater(comparison["paired_gain_percent_ci95"]["high"], 15.0)

    def test_paired_speedup_requires_aligned_trials(self):
        with self.assertRaises(ValueError):
            benchmark.paired_speedup_summary([{"tokens_per_second": 1.0}], [])

    def test_trial_summary_reports_throughput_latency_and_draft_acceptance(self):
        trials = [
            {
                "tokens_per_second": 10.0,
                "generation_seconds": 2.0,
                "time_to_first_token_seconds": 0.2,
                "output_tokens": 20,
                "accepted_draft_tokens": 10,
            },
            {
                "tokens_per_second": 12.0,
                "generation_seconds": 1.8,
                "time_to_first_token_seconds": 0.18,
                "output_tokens": 22,
                "accepted_draft_tokens": 11,
            },
        ]

        summary = benchmark.summarize_trials(trials)

        self.assertEqual(summary["iterations"], 2)
        self.assertEqual(summary["mean_tokens_per_second"], 11.0)
        self.assertEqual(summary["generation_latency_p50_seconds"], 1.9)
        self.assertEqual(summary["draft_acceptance_rate"], 0.5)
        self.assertLess(summary["tokens_per_second_ci95_mean"]["low"], 11.0)
        self.assertGreater(summary["tokens_per_second_ci95_mean"]["high"], 11.0)

    def test_empty_trial_summary_is_rejected(self):
        with self.assertRaises(ValueError):
            benchmark.summarize_trials([])


if __name__ == "__main__":
    unittest.main()
