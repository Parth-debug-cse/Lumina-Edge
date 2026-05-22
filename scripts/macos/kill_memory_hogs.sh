#!/bin/bash
# chmod +x scripts/macos/*.sh
#
# scripts/macos/kill_memory_hogs.sh
# Gracefully stop known memory-hungry background daemons that are safe
# to terminate during an LLM inference session on Apple Silicon.
#
# Usage: ./kill_memory_hogs.sh        (no sudo required for user-owned processes)
#        sudo ./kill_memory_hogs.sh    (also stops system daemons)

# Exit on error — fail fast if any command fails
set -e

# Log prefix for all output
LUMINA_PREFIX="[lumina]"

echo "${LUMINA_PREFIX} === Killing memory-hungry background processes ==="

# User-safe processes — killall (SIGTERM then SIGKILL) stops these gracefully
PROCESSES=(
    "Photos"
    "Siri"
    "NotificationCenter"
    "universalaccessd"
    "AirPlayUIAgent"
    "ControlCenter"
    "com.apple.AmbientDisplayAgent"
    "usernoted"
    "CallHistorySyncHelper"
    "CloudKeychainProxy"
    "com.apple.knowledge-agent"
    "mediaanalysisd"
    "photolibraryd"
    "com.apple.suggestd"
    "parsecd"
)

# killall sends SIGTERM first, then SIGKILL if process doesn't exit — safe for user daemons
for proc in "${PROCESSES[@]}"; do
    if killall "${proc}" 2>/dev/null; then
        echo "${LUMINA_PREFIX}  Killed: ${proc}"
    else
        echo "${LUMINA_PREFIX}  Skipped: ${proc} (not running or could not kill)"
    fi
done

echo ""
# Crash reporters respawn on SIGTERM — use SIGKILL (-KILL) to actually stop them
echo "${LUMINA_PREFIX} Killing crash-reporting processes (SIGKILL)..."

if sudo killall -KILL ReportCrash 2>/dev/null; then
    echo "${LUMINA_PREFIX}  KILLED: ReportCrash"
else
    echo "${LUMINA_PREFIX}  Skipped: ReportCrash (not running)"
fi

if sudo killall -KILL fmfd 2>/dev/null; then
    echo "${LUMINA_PREFIX}  KILLED: fmfd"
else
    echo "${LUMINA_PREFIX}  Skipped: fmfd (not running)"
fi

echo ""
echo "${LUMINA_PREFIX} === Available memory after cleanup ==="

# Parse vm_stat output: page size (bytes), free pages, inactive pages
PAGE_SIZE=$(vm_stat | awk '/page size of/ {print $8}')
FREE_PAGES=$(vm_stat | awk '/pages free/ {gsub(/\./,"",$NF); print $NF}')
INACTIVE_PAGES=$(vm_stat | awk '/pages inactive/ {gsub(/\./,"",$NF); print $NF}')

# Inactive pages are reclaimable by macOS — free + inactive = what MLX can actually use
FREE_BYTES=$(( FREE_PAGES * PAGE_SIZE ))
INACTIVE_BYTES=$(( INACTIVE_PAGES * PAGE_SIZE ))
FREE_MB=$(( FREE_BYTES / 1048576 ))
INACTIVE_MB=$(( INACTIVE_BYTES / 1048576 ))
AVAILABLE_MB=$(( (FREE_PAGES + INACTIVE_PAGES) * PAGE_SIZE / 1048576 ))

echo "${LUMINA_PREFIX}  Free pages:    ${FREE_PAGES}  (${FREE_MB} MB)"
echo "${LUMINA_PREFIX}  Inactive pages: ${INACTIVE_PAGES}  (${INACTIVE_MB} MB)"
echo "${LUMINA_PREFIX}  Available to MLX (free + inactive): ${AVAILABLE_MB} MB"
echo "${LUMINA_PREFIX} Memory hog cleanup complete."
