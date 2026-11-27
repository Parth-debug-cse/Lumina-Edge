import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import mlx_speculative_benchmark as benchmark


class BenchmarkStatisticsTests(unittest.TestCase):
    def test_percentile_interpolates_between_observations(self):
        self.assertEqual(benchmark.percentile([1.0, 2.0, 3.0, 4.0, 5.0], 0.95), 4.8)

    def test_confidence_interval_is_centered_for_single_sample(self):
        self.assertEqual(benchmark.confidence_interval_95([12.0]), {"low": 12.0, "high": 12.0})

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
