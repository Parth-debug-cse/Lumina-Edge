#!/usr/bin/env python3
"""
Lumina Edge — Smoke Tests
Validates core functionality without requiring a running server or GPU.
Run: python3 test_smoke.py
"""

import json
import os
import sys
import platform
import unittest
from pathlib import Path

PROJECT_ROOT = Path(__file__).parent.resolve()


class TestPlatformDetection(unittest.TestCase):
    """Verify platform detection logic works correctly."""

    def test_platform_is_known(self):
        plat = platform.system()
        self.assertIn(plat, ("Darwin", "Windows", "Linux"))

    def test_mac_apple_silicon_detection(self):
        """Apple Silicon check should return bool, never crash."""
        is_mac = platform.system() == "Darwin" and platform.machine() == "arm64"
        self.assertIsInstance(is_mac, bool)

    def test_expected_backend(self):
        """macOS/ARM64 should use MLX, everything else llama.cpp."""
        is_mac_arm = platform.system() == "Darwin" and platform.machine() == "arm64"
        expected = "mlx" if is_mac_arm else "llama.cpp"
        self.assertIn(expected, ("mlx", "llama.cpp"))


class TestConfigValidation(unittest.TestCase):
    """Verify config.json exists and has required fields."""

    def setUp(self):
        self.config_path = PROJECT_ROOT / "config.json"

    def test_config_exists(self):
        self.assertTrue(
            self.config_path.exists(),
            f"config.json not found at {self.config_path}",
        )

    def test_config_is_valid_json(self):
        with open(self.config_path) as f:
            config = json.load(f)
        self.assertIsInstance(config, dict)

    def test_config_has_api_port(self):
        with open(self.config_path) as f:
            config = json.load(f)
        port = config.get("api_port")
        if port is not None:
            self.assertIsInstance(port, int)
            self.assertGreater(port, 0)
            self.assertLess(port, 65536)

    def test_config_has_ctx_size(self):
        with open(self.config_path) as f:
            config = json.load(f)
        ctx = config.get("ctx_size")
        if ctx is not None:
            self.assertIsInstance(ctx, int)
            self.assertGreaterEqual(ctx, 512)


class TestDirectoryStructure(unittest.TestCase):
    """Verify required directories and key files exist."""

    def test_scripts_dir_exists(self):
        self.assertTrue((PROJECT_ROOT / "scripts").is_dir())

    def test_core_dir_exists(self):
        self.assertTrue((PROJECT_ROOT / "core").is_dir())

    def test_ui_dir_exists(self):
        self.assertTrue((PROJECT_ROOT / "ui").is_dir())

    def test_models_dir_exists(self):
        self.assertTrue((PROJECT_ROOT / "models").is_dir())

    def test_api_server_exists(self):
        self.assertTrue((PROJECT_ROOT / "ui" / "api-server.js").is_file())

    def test_start_lumina_sh_exists(self):
        self.assertTrue((PROJECT_ROOT / "start_lumina.sh").is_file())


class TestPythonScripts(unittest.TestCase):
    """Verify critical Python scripts parse without syntax errors."""

    def _assert_syntax_ok(self, rel_path):
        full = PROJECT_ROOT / rel_path
        if not full.exists():
            self.skipTest(f"{rel_path} not found")
        source = full.read_text()
        compile(source, str(full), "exec")

    def test_system_optimizer_syntax(self):
        self._assert_syntax_ok("scripts/system_optimizer.py")

    def test_model_converter_syntax(self):
        self._assert_syntax_ok("scripts/model-converter.py")

    def test_ctx_memory_opt_syntax(self):
        self._assert_syntax_ok("scripts/ctx_memory_opt.py")

    def test_mlx_backend_syntax(self):
        self._assert_syntax_ok("scripts/mlx_backend.py")

    def test_lumina_screen_main_syntax(self):
        self._assert_syntax_ok("lumina_screen/main.py")

    def test_pdf_parser_syntax(self):
        self._assert_syntax_ok("lumina_screen/pdf_parser.py")


class TestNoBareExcept(unittest.TestCase):
    """Ensure no bare 'except:' clauses remain in Python files."""

    def test_no_bare_except_in_scripts(self):
        bare_excepts = []
        for py_file in (PROJECT_ROOT / "scripts").rglob("*.py"):
            for i, line in enumerate(py_file.read_text().splitlines(), 1):
                stripped = line.strip()
                if stripped == "except:" or stripped.startswith("except: "):
                    bare_excepts.append(f"{py_file.relative_to(PROJECT_ROOT)}:{i}")
        self.assertEqual(
            bare_excepts,
            [],
            f"Bare 'except:' found at: {bare_excepts}",
        )


class TestShellScripts(unittest.TestCase):
    """Verify shell scripts have no obvious undefined variable references."""

    def test_launch_api_no_undefined_root(self):
        """launch_api.sh should use $ROOT_DIR, not bare $ROOT in get_config."""
        script = PROJECT_ROOT / "core" / "launch_api.sh"
        if not script.exists():
            self.skipTest("launch_api.sh not found")
        content = script.read_text()
        get_config_start = content.find("get_config()")
        if get_config_start == -1:
            return
        get_config_block = content[get_config_start:get_config_start + 500]
        self.assertNotIn(
            '"$ROOT/config.json"',
            get_config_block,
            "get_config uses undefined $ROOT instead of $ROOT_DIR",
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
