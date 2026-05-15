#!/bin/bash
# chmod +x scripts/macos/*.sh
#
# scripts/macos/ram_monitor.sh
# Live RAM dashboard — polls vm_stat every 5 seconds and displays key
# memory metrics in MB. Designed to run alongside Lumina Edge inference.
#
# Usage: ./ram_monitor.sh

LUMINA_PREFIX="[lumina]"

trap 'echo ""; echo "${LUMINA_PREFIX} Monitoring stopped."; exit 0' SIGINT SIGTERM

PAGE_SIZE=16384

echo "${LUMINA_PREFIX} Live RAM Monitor — Ctrl+C to stop"
echo "${LUMINA_PREFIX} Page size: ${PAGE_SIZE} bytes (Apple Silicon)"
echo ""

while true; do
    clear
    TIMESTAMP=$(date "+%Y-%m-%d %H:%M:%S")
    echo "${LUMINA_PREFIX} === RAM Dashboard @ ${TIMESTAMP} ==="
    echo ""

    vm_stat | awk -v ps="${PAGE_SIZE}" -v prefix="${LUMINA_PREFIX}" '
    /pages free/               { free=$NF; gsub(/\./,"",free) }
    /pages inactive/           { inactive=$NF; gsub(/\./,"",inactive) }
    /pages active/             { active=$NF; gsub(/\./,"",active) }
    /pages wired down/         { wired=$NF; gsub(/\./,"",wired) }
    /pages occupied by compressor/ { compressor=$NF; gsub(/\./,"",compressor) }
    END {
        free_mb     = free     * ps / 1048576
        inactive_mb = inactive * ps / 1048576
        active_mb   = active   * ps / 1048576
        wired_mb    = wired    * ps / 1048576
        comp_mb     = compressor * ps / 1048576
        avail_mb    = (free + inactive) * ps / 1048576

        printf "%s  Free:            %6s pages  %6d MB\n", prefix, free, free_mb
        printf "%s  Inactive:        %6s pages  %6d MB\n", prefix, inactive, inactive_mb
        printf "%s  Active:          %6s pages  %6d MB\n", prefix, active, active_mb
        printf "%s  Wired:           %6s pages  %6d MB\n", prefix, wired, wired_mb
        printf "%s  Compressor:      %6s pages  %6d MB\n", prefix, compressor, comp_mb
        printf "\n"
        printf "%s  Available to MLX (free + inactive): %d MB\n", prefix, avail_mb
    }'

    sleep 5
done
