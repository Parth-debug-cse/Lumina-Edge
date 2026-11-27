import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import system_optimizer


class SystemOptimizerTests(unittest.TestCase):
    def test_cpu_only_configuration_does_not_require_gpu_metadata(self):
        optimizer = system_optimizer.SystemOptimizer.__new__(system_optimizer.SystemOptimizer)
        optimizer.system_info = {
            "cpu": {"physical_cores": 4, "logical_cores": 8},
            "memory": {"total_gb": 8, "available_gb": 6},
            "gpus": [],
        }

        with patch.object(system_optimizer.platform, "system", return_value="Linux"), \
                patch.object(system_optimizer.platform, "machine", return_value="x86_64"):
            config = optimizer.optimize_config()

        self.assertEqual(config["split_mode"], "row")
        self.assertEqual(config["threads"], 4)

    def test_save_config_creates_missing_config_file(self):
        optimizer = system_optimizer.SystemOptimizer.__new__(system_optimizer.SystemOptimizer)
        optimizer.optimized_config = {"threads": 4}

        with tempfile.TemporaryDirectory() as temp_dir:
            config_path = Path(temp_dir) / "config.json"
            self.assertTrue(optimizer.save_config(str(config_path)))
            self.assertEqual(json.loads(config_path.read_text(encoding="utf-8")), {"threads": 4})

    def test_windows_cpu_fallback_handles_missing_psutil_values(self):
        optimizer = system_optimizer.SystemOptimizer.__new__(system_optimizer.SystemOptimizer)
        with patch.object(system_optimizer.psutil, "cpu_count", return_value=None), \
                patch.object(system_optimizer.psutil, "cpu_freq", return_value=None):
            cpu_info = optimizer._detect_windows_cpu()

        self.assertEqual(cpu_info["physical_cores"], 1)
        self.assertEqual(cpu_info["logical_cores"], 1)
        self.assertEqual(cpu_info["threads_per_core"], 1)
        self.assertEqual(cpu_info["frequency_mhz"], 0)


if __name__ == "__main__":
    unittest.main()
