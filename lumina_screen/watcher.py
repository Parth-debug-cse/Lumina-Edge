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
        self.interval = poll_interval_ms / 1000.0  # Convert ms to seconds for time.sleep()
        self._known = set()
        self._refresh()  # Snapshot current PDFs so first poll() only returns truly new files

    def _refresh(self):
        """Re-scan folder and store the set of PDFs as the new known baseline."""
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
        time.sleep(self.interval)  # Blocking sleep — this is a polling loop, not async
        pattern = os.path.join(self.folder, "*")
        current = {
            f for f in glob.glob(pattern)
            if os.path.isfile(f) and f.lower().endswith(".pdf")
        }
        new_files = sorted(current - self._known)  # Set difference = only newly appeared files
        self._known = current
        return new_files

    def reset(self):
        """Re-scan known files without sleeping (used at startup)."""
        self._refresh()
