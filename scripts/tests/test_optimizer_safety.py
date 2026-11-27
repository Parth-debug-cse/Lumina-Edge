import builtins
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import mock_open, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from scripts import optimize_system, system_optimizer


class OptimizerSafetyTests(unittest.TestCase):
    def test_save_config_preserves_user_values_and_adds_only_missing_values(self):
        optimizer = system_optimizer.SystemOptimizer.__new__(system_optimizer.SystemOptimizer)
        optimizer.optimized_config = {
            "threads": 8,
            "new_recommendation": True,
            "nested": {"recommended": 1},
        }

        original = {
            "threads": 12,
            "api_port": 8123,
            "nested": {"user_value": 2},
        }
        with tempfile.TemporaryDirectory() as temp_dir:
            config_path = Path(temp_dir) / "config.json"
            config_path.write_text(json.dumps(original), encoding="utf-8")

            self.assertTrue(optimizer.save_config(str(config_path)))

            saved = json.loads(config_path.read_text(encoding="utf-8"))
            self.assertEqual(saved["threads"], 12)
            self.assertEqual(saved["api_port"], 8123)
            self.assertEqual(saved["nested"], {"user_value": 2})
            self.assertTrue(saved["new_recommendation"])

    def test_save_config_does_not_replace_invalid_existing_config(self):
        optimizer = system_optimizer.SystemOptimizer.__new__(system_optimizer.SystemOptimizer)
        optimizer.optimized_config = {"threads": 4}

        with tempfile.TemporaryDirectory() as temp_dir:
            config_path = Path(temp_dir) / "config.json"
            invalid_contents = "not valid json"
            config_path.write_text(invalid_contents, encoding="utf-8")

            self.assertFalse(optimizer.save_config(str(config_path)))
            self.assertEqual(config_path.read_text(encoding="utf-8"), invalid_contents)

    def test_linux_default_does_not_write_host_settings_or_run_commands(self):
        real_open = builtins.open

        def reject_writes(file, mode="r", *args, **kwargs):
            if any(flag in mode for flag in ("w", "a", "+")):
                raise AssertionError(f"unexpected write to {file}")
            return real_open(file, mode, *args, **kwargs)

        with patch.dict(os.environ, {}, clear=True), \
                patch.object(optimize_system.os, "geteuid", return_value=0), \
                patch.object(optimize_system.Path, "exists", return_value=True), \
                patch("builtins.open", side_effect=reject_writes), \
                patch.object(optimize_system, "get_memory_stats", return_value=1024), \
                patch.object(optimize_system.subprocess, "run") as run:
            self.assertEqual(optimize_system.optimize_linux(), 0)

        run.assert_not_called()

    def test_linux_opt_in_writes_and_commands_are_fully_mocked(self):
        with patch.dict(os.environ, {"LUMINA_SYSTEM_TUNING": "1"}, clear=True), \
                patch.object(optimize_system.os, "geteuid", return_value=0), \
                patch.object(optimize_system.Path, "exists", return_value=True), \
                patch("builtins.open", mock_open()), \
                patch.object(optimize_system, "get_memory_stats", return_value=1024), \
                patch.object(optimize_system.subprocess, "run", return_value=type("Result", (), {"returncode": 0})()) as run:
            self.assertEqual(optimize_system.optimize_linux(), 0)

        run.assert_called_once()
        self.assertEqual(run.call_args.args[0][0], "cpupower")

    def test_windows_default_does_not_run_host_commands(self):
        with patch.dict(os.environ, {}, clear=True), \
                patch.object(optimize_system, "get_memory_stats", return_value=1024), \
                patch.object(optimize_system.subprocess, "run") as run:
            self.assertEqual(optimize_system.optimize_windows(), 0)

        run.assert_not_called()

    def test_windows_opt_in_commands_are_mocked(self):
        with patch.dict(os.environ, {"LUMINA_SYSTEM_TUNING": "1"}, clear=True), \
                patch.object(optimize_system, "get_memory_stats", return_value=1024), \
                patch.object(optimize_system.subprocess, "run") as run:
            self.assertEqual(optimize_system.optimize_windows(), 0)

        self.assertEqual(run.call_count, 2)

    def test_macos_default_does_not_run_purge(self):
        with patch.dict(os.environ, {}, clear=True), \
                patch.object(optimize_system, "get_memory_stats", return_value=1024), \
                patch.object(optimize_system.subprocess, "run") as run:
            self.assertEqual(optimize_system.optimize_macos(), 0)

        run.assert_not_called()

    def test_macos_opt_in_purge_is_mocked(self):
        with patch.dict(os.environ, {"LUMINA_PURGE_MEMORY": "1"}, clear=True), \
                patch.object(optimize_system, "get_memory_stats", return_value=1024), \
                patch.object(optimize_system.subprocess, "run") as run:
            self.assertEqual(optimize_system.optimize_macos(), 0)

        run.assert_called_once_with(["purge"], capture_output=True, check=False)


if __name__ == "__main__":
    unittest.main()
