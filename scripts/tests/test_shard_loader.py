import subprocess
import sys
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "shard-loader.py"


def test_cli_reports_memory_estimate_for_a_single_model_file(tmp_path):
    model_path = tmp_path / "tiny.safetensors"
    model_path.write_bytes(b"")

    result = subprocess.run(
        [sys.executable, str(SCRIPT), str(model_path)],
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert "Memory Estimate: 0.00 GB" in result.stdout
