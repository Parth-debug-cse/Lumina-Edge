import os
import platform
import subprocess
import threading
from datetime import datetime


# BUG LS-6 FIX: Module-level lock to prevent race condition when two resumes
# are shortlisted near-simultaneously and both try to append to page_hit.txt.
_log_lock = threading.Lock()


def notify(entry):
    """
    Fire an OS-native desktop notification.
      macOS  : osascript display notification
      Linux  : notify-send
      Windows: PowerShell Wscript.Shell Popup
    Silently ignores failures (non-critical).
    """
    system = platform.system()
    title = f"Lumina Screen - {entry['name']}"
    msg = f"Score: {entry['score']:.2f} | {entry['filename']}"

    try:
        if system == "Darwin":
            safe_title = title.replace('"', '\\"')
            safe_msg = msg.replace('"', '\\"')
            subprocess.run(
                [
                    "osascript",
                    "-e",
                    f'display notification "{safe_msg}" with title "{safe_title}"',
                ],
                capture_output=True,
                timeout=5,
            )
        elif system == "Linux":
            subprocess.run(
                ["notify-send", title, msg],
                capture_output=True,
                timeout=5,
            )
        elif system == "Windows":
            safe_title = title.replace('"', '\\"')
            safe_msg = msg.replace('"', '\\"')
            subprocess.run(
                [
                    "powershell",
                    "-Command",
                    f'$p=New-Object -ComObject Wscript.Shell; $p.Popup("{safe_msg}",5,"{safe_title}",0)',
                ],
                capture_output=True,
                timeout=5,
            )
    except Exception:
        pass


def log_hit(entry, page_hit_path):
    """
    Append a shortlisted candidate entry to page_hit.txt.
    Format: [TIMESTAMP] | [NAME] | [FILENAME] | [SCORE] | [EMAIL] | [PHONE]
    Creates the file if it doesn't exist.
    """
    # BUG LS-5 FIX: os.makedirs("") raises FileNotFoundError when page_hit_path
    # has no directory component. Only create the directory if it is non-empty.
    parent_dir = os.path.dirname(page_hit_path)
    if parent_dir:
        os.makedirs(parent_dir, exist_ok=True)

    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    line = (
        f"[{timestamp}] | {entry['name']} | {entry['filename']} | "
        f"{entry['score']:.4f} | {entry['email']} | {entry['phone']}\n"
    )
    # BUG LS-6 FIX: Acquire the module-level lock before writing so that two
    # threads cannot interleave partial writes producing corrupt log lines.
    with _log_lock:
        with open(page_hit_path, "a") as f:
            f.write(line)
