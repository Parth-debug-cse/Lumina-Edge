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

echo "${LUMINA_PREFIX} === Purge & Prep — flushing system caches ==="

echo "${LUMINA_PREFIX} Disabling Spotlight indexing..."
sudo mdutil -a -i off 2>/dev/null || echo "${LUMINA_PREFIX} WARNING: Could not disable Spotlight (may already be off or unavailable)."

echo "${LUMINA_PREFIX} Stopping Time Machine backups..."
sudo tmutil stopbackup 2>/dev/null || echo "${LUMINA_PREFIX} WARNING: Could not stop Time Machine backup (none in progress or unavailable)."

echo "${LUMINA_PREFIX} Purging disk cache and inactive memory..."
sudo purge 2>/dev/null || echo "${LUMINA_PREFIX} WARNING: purge command failed (may require SIP-permitted terminal)."

echo "${LUMINA_PREFIX} Flushing DNS cache..."
sudo dscacheutil -flushcache 2>/dev/null || echo "${LUMINA_PREFIX} WARNING: dscacheutil flush failed."
sudo killall -HUP mDNSResponder 2>/dev/null || echo "${LUMINA_PREFIX} WARNING: Could not restart mDNSResponder."

echo ""
echo "${LUMINA_PREFIX} === Post-flush VM statistics ==="
vm_stat | awk -v prefix="${LUMINA_PREFIX}" '
/pages free/           { free=$NF; gsub(/\./,"",free) }
/pages active/         { active=$NF; gsub(/\./,"",active) }
/pages inactive/       { inactive=$NF; gsub(/\./,"",inactive) }
/pages wired/          { wired=$NF; gsub(/\./,"",wired) }
/pages occupied/       { compressor=$NF; gsub(/\./,"",compressor) }
END {
    ps=16384
    printf "%s  Free:       %6s pages  (%6d MB)\n", prefix, free, free*ps/1048576
    printf "%s  Inactive:   %6s pages  (%6d MB)\n", prefix, inactive, inactive*ps/1048576
    printf "%s  Active:     %6s pages  (%6d MB)\n", prefix, active, active*ps/1048576
    printf "%s  Wired:      %6s pages  (%6d MB)\n", prefix, wired, wired*ps/1048576
    printf "%s  Compressor: %6s pages  (%6d MB)\n", prefix, compressor, compressor*ps/1048576
}'

echo "${LUMINA_PREFIX} Purge and prep complete."
