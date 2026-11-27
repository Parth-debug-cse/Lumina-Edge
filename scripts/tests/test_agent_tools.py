import json
import os
import signal
import shlex
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from lumina_agent import agent as agent_module
from lumina_agent.config import get_agent_tool_budget, get_tool_timeout
from lumina_agent.tools import ToolMetrics, _is_safe_write_path, execute_tool, run_shell, write_file


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

    def test_sensitive_home_paths_are_refused_but_workspace_writes_remain_allowed(self):
        home = os.path.realpath(os.path.expanduser("~/"))
        protected_paths = (
            os.path.join(home, ".ssh", "authorized_keys"),
            os.path.join(home, ".aws", "credentials"),
            os.path.join(home, ".bashrc"),
            os.path.join(home, ".zshenv"),
            os.path.join(home, ".config", "fish", "config.fish"),
        )
        for path in protected_paths:
            with self.subTest(path=path):
                self.assertFalse(_is_safe_write_path(path))

        safe_workspace_file = os.path.join(home, "workspace", "project", "notes.txt")
        self.assertTrue(_is_safe_write_path(safe_workspace_file))
        refused = write_file(os.path.join(home, ".ssh", "lumina-test-key"), "not written")
        self.assertIn("protected sensitive home path", refused)

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
        with patch.dict(os.environ, {"LUMINA_TOOL_TIMEOUT": "10000"}):
            self.assertEqual(get_tool_timeout(), 300)

    def test_cumulative_tool_budget_is_configurable_and_clamped(self):
        with patch.dict(os.environ, {"LUMINA_AGENT_TOOL_BUDGET": "10000"}):
            self.assertEqual(get_agent_tool_budget(), 3600)
        with patch.dict(os.environ, {"LUMINA_AGENT_TOOL_BUDGET": "nan"}):
            self.assertEqual(get_agent_tool_budget(), 300)

    def test_tool_output_is_bounded(self):
        with patch.dict(os.environ, {"LUMINA_AGENT_ALLOW_SHELL": "yes"}):
            result = run_shell(self._python_command("print('x' * 2000)"))
        self.assertTrue(result.startswith("x" * 100))
        self.assertTrue(result.endswith("...[truncated]"))
        self.assertLessEqual(len(result), 1520)

    def test_tool_metrics_include_duration_and_error_status(self):
        metrics: ToolMetrics = {}
        with patch.dict(os.environ, {"LUMINA_AGENT_ALLOW_SHELL": "1"}):
            result = execute_tool(
                "run_shell",
                {"command": self._python_command("print('metric test')")},
                metrics=metrics,
            )
        self.assertEqual(result, "metric test")
        self.assertIsInstance(metrics.get("duration_seconds"), (int, float))
        self.assertFalse(metrics.get("error", True))
        self.assertEqual(metrics.get("status"), "ok")

    @unittest.skipIf(os.name == "nt", "POSIX process-group behavior")
    def test_timeout_kills_descendant_processes(self):
        with tempfile.TemporaryDirectory() as directory:
            pid_path = os.path.join(directory, "child.pid")
            marker_path = os.path.join(directory, "child-survived")
            source = self._process_tree_source(pid_path, marker_path, 2.2)
            with patch.dict(os.environ, {
                "LUMINA_AGENT_ALLOW_SHELL": "1",
                "LUMINA_TOOL_TIMEOUT": "1",
            }):
                result = run_shell(self._python_command(source))
            self.assertIn("timed out", result)
            self._wait_for_path(pid_path)
            time.sleep(1.5)
            self.assertFalse(os.path.exists(marker_path), "descendant survived command timeout")

    @unittest.skipIf(os.name == "nt", "POSIX process-group behavior")
    def test_sigterm_cancels_agent_tool_and_kills_descendant_processes(self):
        with tempfile.TemporaryDirectory() as directory:
            pid_path = os.path.join(directory, "child.pid")
            marker_path = os.path.join(directory, "child-survived")
            source = self._process_tree_source(pid_path, marker_path, 1.5)
            response = json.dumps({
                "tool": "run_shell",
                "args": {"command": self._python_command(source)},
            })
            agent_source = (
                "from lumina_agent import agent as agent_module; "
                f"agent_module.call_llm = lambda _messages: {response!r}; "
                "agent_module.run_agent('SIGTERM cancellation test', 'sigterm-test')"
            )
            project_root = os.path.dirname(os.path.dirname(os.path.dirname(__file__)))
            env = os.environ.copy()
            env.update({
                "LUMINA_AGENT_ALLOW_SHELL": "1",
                "LUMINA_TOOL_TIMEOUT": "10",
                "PYTHONPATH": project_root,
            })
            worker = subprocess.Popen(
                [sys.executable, "-c", agent_source],
                cwd=project_root,
                env=env,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            try:
                self._wait_for_path(pid_path)
                worker.send_signal(signal.SIGTERM)
                worker.wait(timeout=4)
                time.sleep(1.7)
                self.assertFalse(os.path.exists(marker_path), "tool descendant survived agent SIGTERM")
            finally:
                if worker.poll() is None:
                    worker.kill()
                    worker.wait(timeout=2)

    @unittest.skipIf(os.name == "nt", "POSIX process-group behavior")
    def test_agent_cancellation_kills_descendant_processes(self):
        with tempfile.TemporaryDirectory() as directory:
            pid_path = os.path.join(directory, "child.pid")
            marker_path = os.path.join(directory, "child-survived")
            source = self._process_tree_source(pid_path, marker_path, 1.5)
            result_holder = {}
            run_id = "cancel-tree-test"
            response = json.dumps({
                "tool": "run_shell",
                "args": {"command": self._python_command(source)},
            })
            with patch.dict(os.environ, {
                "LUMINA_AGENT_ALLOW_SHELL": "1",
                "LUMINA_TOOL_TIMEOUT": "5",
            }), patch.object(agent_module, "call_llm", return_value=response):
                worker = threading.Thread(
                    target=lambda: result_holder.setdefault(
                        "result",
                        agent_module.run_agent("cancel test", run_id),
                    )
                )
                worker.start()
                self._wait_for_path(pid_path)
                agent_module.stop_agent(run_id)
                worker.join(timeout=4)
                self.assertFalse(worker.is_alive(), "cancelled agent tool did not return")
            self.assertIn("Interrupted by user", result_holder["result"])
            time.sleep(1.7)
            self.assertFalse(os.path.exists(marker_path), "descendant survived agent cancellation")

    def test_agent_enforces_cumulative_tool_wall_clock_budget(self):
        shell_call = lambda delay: json.dumps({
            "tool": "run_shell",
            "args": {"command": self._python_command(f"import time; time.sleep({delay})")},
        })
        updates = []
        with patch.dict(os.environ, {
            "LUMINA_AGENT_ALLOW_SHELL": "1",
            "LUMINA_TOOL_TIMEOUT": "5",
            "LUMINA_AGENT_TOOL_BUDGET": "1.2",
        }), patch.object(
            agent_module,
            "call_llm",
            side_effect=[shell_call(0.65), shell_call(5)],
        ) as call_llm:
            result = agent_module.run_agent("test budget", "budget-test", updates.append)

        self.assertIn("Cumulative tool wall-clock budget exhausted", result)
        self.assertEqual(call_llm.call_count, 2)
        self.assertEqual(len(updates), 2)
        self.assertTrue(updates[1]["tool_metrics"]["timed_out"])
        self.assertTrue(updates[1]["tool_metrics"]["budget_exhausted"])

    def _process_tree_source(self, pid_path, marker_path, child_delay):
        child_source = (
            f"import time; time.sleep({child_delay}); "
            f"open({marker_path!r}, 'w').write('survived')"
        )
        return (
            "import subprocess, sys, time; "
            f"child = subprocess.Popen([sys.executable, '-c', {child_source!r}]); "
            f"open({pid_path!r}, 'w').write(str(child.pid)); "
            "time.sleep(30)"
        )

    def _wait_for_path(self, path, timeout=4):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if os.path.exists(path):
                return
            time.sleep(0.02)
        self.fail(f"timed out waiting for {path}")


if __name__ == "__main__":
    unittest.main()
