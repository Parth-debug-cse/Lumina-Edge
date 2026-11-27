import os
import shlex
import subprocess
import sys
import time
import unittest
from unittest.mock import patch

from lumina_agent.tools import _is_safe_write_path, run_shell


class AgentToolSafetyTests(unittest.TestCase):
    def _python_command(self, source):
        args = [sys.executable, "-c", source]
        if os.name == "nt":
            return subprocess.list2cmdline(args)
        return shlex.join(args)

    def test_write_path_uses_directory_boundaries_not_string_prefixes(self):
        home = os.path.realpath(os.path.expanduser("~/"))
        sibling_path = home.rstrip(os.sep) + "-other/secret.txt"
        self.assertFalse(_is_safe_write_path(sibling_path))

    def test_shell_execution_requires_explicit_opt_in(self):
        with patch.dict(os.environ, {"LUMINA_AGENT_ALLOW_SHELL": "false"}):
            result = run_shell("echo should-not-run")
        self.assertIn("run_shell is disabled", result)

    def test_tool_timeout_is_configurable_and_clamped(self):
        with patch.dict(os.environ, {
            "LUMINA_AGENT_ALLOW_SHELL": "1",
            "LUMINA_TOOL_TIMEOUT": "1",
        }):
            started = time.monotonic()
            result = run_shell(self._python_command("import time; time.sleep(10)"))
            elapsed = time.monotonic() - started
        self.assertIn("timed out after 1s", result)
        self.assertLess(elapsed, 5)

    def test_tool_output_is_bounded(self):
        with patch.dict(os.environ, {"LUMINA_AGENT_ALLOW_SHELL": "yes"}):
            result = run_shell(self._python_command("print('x' * 2000)"))
        self.assertTrue(result.startswith("x" * 100))
        self.assertTrue(result.endswith("...[truncated]"))
        self.assertLessEqual(len(result), 1520)


if __name__ == "__main__":
    unittest.main()
