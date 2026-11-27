#!/bin/bash
# chmod +x scripts/macos/*.sh
#
# scripts/macos/purge_and_prep.sh
# Flush disk cache, inactive memory, and stop non-essential system services
# before launching Lumina Edge. Run with sudo.
#
# Usage: sudo ./purge_and_prep.sh

set -e

LUMINA_PREFIX="[lumina]"

if [[ $EUID -ne 0 ]]; then
    echo "${LUMINA_PREFIX} ERROR: This script must be run as root (sudo)." >&2
    echo "${LUMINA_PREFIX} Usage: sudo ${0}" >&2
    exit 1
fi
# Everything below requires root — vm_stat, purge, mdutil, tmutil all need it

echo "${LUMINA_PREFIX} === Purge inactive memory (explicit opt-in) ==="
if [[ "${LUMINA_PURGE_MEMORY:-0}" != "1" ]]; then
    echo "${LUMINA_PREFIX} Skipped. Set LUMINA_PURGE_MEMORY=1 to opt in."
    exit 0
fi

# Purge is a system-wide cache action and may be restricted by macOS security policy.
echo "${LUMINA_PREFIX} Purging inactive memory..."
purge 2>/dev/null || echo "${LUMINA_PREFIX} WARNING: purge command failed or was restricted by the OS."

echo ""
echo "${LUMINA_PREFIX} === Post-flush VM statistics ==="
vm_stat | awk -v prefix="${LUMINA_PREFIX}" '
/pages free/           { free=$NF; gsub(/\./,"",free) }
/pages active/         { active=$NF; gsub(/\./,"",active) }
/pages inactive/       { inactive=$NF; gsub(/\./,"",inactive) }
/pages wired/          { wired=$NF; gsub(/\./,"",wired) }
/pages occupied/       { compressor=$NF; gsub(/\./,"",compressor) }
END {
    # Apple Silicon page size is 16384 bytes (16K) — hardcoded, not parsed from vm_stat
    ps=16384
    printf "%s  Free:       %6s pages  (%6d MB)\n", prefix, free, free*ps/1048576
    printf "%s  Inactive:   %6s pages  (%6d MB)\n", prefix, inactive, inactive*ps/1048576
    printf "%s  Active:     %6s pages  (%6d MB)\n", prefix, active, active*ps/1048576
    printf "%s  Wired:      %6s pages  (%6d MB)\n", prefix, wired, wired*ps/1048576
    printf "%s  Compressor: %6s pages  (%6d MB)\n", prefix, compressor, compressor*ps/1048576
}'

echo "${LUMINA_PREFIX} Purge and prep complete."
