import os
import time
import glob


class Watcher:
    """
    Polls a folder for newly added files by diffing the current directory
    state against a known set. Pure time.sleep() polling — no inotify,
    no watchdog, no FSEvents. Works identically on Windows, Linux, and macOS.
    """

    def __init__(self, folder, poll_interval_ms=300):
        self.folder = os.path.abspath(folder)
        self.interval = poll_interval_ms / 1000.0
        self._known = set()
        self._refresh()

    def _refresh(self):
        pattern = os.path.join(self.folder, "*")
        self._known = {
            f for f in glob.glob(pattern)
            if os.path.isfile(f) and f.lower().endswith(".pdf")
        }

    def poll(self):
        """
        Sleep for the configured interval, then return a sorted list of
        newly detected file paths. Blocks for poll_interval_ms.
        """
        time.sleep(self.interval)
        pattern = os.path.join(self.folder, "*")
        current = {
            f for f in glob.glob(pattern)
            if os.path.isfile(f) and f.lower().endswith(".pdf")
        }
        new_files = sorted(current - self._known)
        self._known = current
        return new_files

    def reset(self):
        """Re-scan known files without sleeping (used at startup)."""
        self._refresh()
