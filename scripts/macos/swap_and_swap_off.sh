#!/bin/bash
# chmod +x scripts/macos/*.sh
#
# scripts/macos/swap_and_swap_off.sh
# Check and optionally disable/enable macOS dynamic_pager (swap).
#
# On Apple Silicon, swap usage degrades MLX performance severely since
# RAM and GPU share unified memory. Disabling swap for inference sessions
# prevents model weights from being paged out.
#
# WARNING: Disabling swap is safe only for the duration of an inference
# session. Re-enable swap immediately after the session completes.
#
# Usage:
#   ./swap_and_swap_off.sh              — status check (default)
#   ./swap_and_swap_off.sh --disable    — disable swap
#   ./swap_and_swap_off.sh --enable     — re-enable swap

set -e

LUMINA_PREFIX="[lumina]"
PAGER_PLIST="/System/Library/LaunchDaemons/com.apple.dynamic_pager.plist"
SWAP_DIR="/private/var/vm"

usage() {
    echo "${LUMINA_PREFIX} Usage: ${0} [--disable | --enable]"
    echo "${LUMINA_PREFIX}   (no args)  — print current swap status"
    echo "${LUMINA_PREFIX}   --disable  — unload dynamic_pager and remove swapfiles"
    echo "${LUMINA_PREFIX}   --enable   — reload dynamic_pager"
    exit 0
}

show_status() {
    echo "${LUMINA_PREFIX} === Current swap status ==="
    SWAP_USAGE=$(sysctl vm.swapusage 2>/dev/null || echo "unavailable")

    if [[ "${SWAP_USAGE}" == "unavailable" ]]; then
        echo "${LUMINA_PREFIX} WARNING: Could not read swap usage (sysctl unavailable)."
    else
        echo "${LUMINA_PREFIX} ${SWAP_USAGE}"
        # Extract total and used in MB (format: total = 2048.00M  used = 123.45M)
        USED=$(echo "${SWAP_USAGE}" | awk -F'used = ' '{print $2}' | awk '{print $1}' | sed 's/M//')
        TOTAL=$(echo "${SWAP_USAGE}" | awk -F'total = ' '{print $2}' | awk '{print $1}' | sed 's/M//')

        if command -v bc &>/dev/null; then
            SWAP_GT_100=$(echo "${USED} > 100" | bc -l 2>/dev/null)
        else
            SWAP_GT_100=$(awk -v u="$USED" 'BEGIN {print (u > 100 ? 1 : 0)}' 2>/dev/null)
        fi
        if (( SWAP_GT_100 )); then
            echo "${LUMINA_PREFIX} WARNING: Swap usage is ${USED}M (> 100 MB)."
            echo "${LUMINA_PREFIX} Consider running with --disable for inference sessions."
        else
            echo "${LUMINA_PREFIX} Swap usage is low (${USED}M / ${TOTAL}M)."
        fi

        # Check if dynamic_pager is loaded
        if sudo launchctl list com.apple.dynamic_pager &>/dev/null; then
            echo "${LUMINA_PREFIX} dynamic_pager is currently LOADED (swap enabled)."
        else
            echo "${LUMINA_PREFIX} dynamic_pager is currently UNLOADED (swap disabled)."
        fi
    fi
}

disable_swap() {
    echo "${LUMINA_PREFIX} === Disabling swap ==="
    echo "${LUMINA_PREFIX} WARNING: Swap will remain disabled until re-enabled."
    echo "${LUMINA_PREFIX} Re-enable with: ${0} --enable"
    echo ""

    if sudo launchctl unload "${PAGER_PLIST}" 2>/dev/null; then
        echo "${LUMINA_PREFIX} dynamic_pager unloaded successfully."
    else
        echo "${LUMINA_PREFIX} WARNING: Could not unload dynamic_pager (may already be unloaded)."
    fi

    # Remove existing swapfiles
    if ls "${SWAP_DIR}/swapfile"* 2>/dev/null; then
        echo "${LUMINA_PREFIX} Removing existing swapfiles..."
        sudo rm -f "${SWAP_DIR}/swapfile"* 2>/dev/null || \
            echo "${LUMINA_PREFIX} WARNING: Could not remove swapfiles (try reboot)."
    else
        echo "${LUMINA_PREFIX} No swapfiles found to remove."
    fi

    echo ""
    echo "${LUMINA_PREFIX} Swap is now DISABLED. Memory will not be paged to disk."
    echo "${LUMINA_PREFIX} Re-enable after inference with: ${0} --enable"
}

enable_swap() {
    echo "${LUMINA_PREFIX} === Re-enabling swap ==="

    if sudo launchctl load "${PAGER_PLIST}" 2>/dev/null; then
        echo "${LUMINA_PREFIX} dynamic_pager loaded successfully."
        echo "${LUMINA_PREFIX} Swap is now ENABLED."
    else
        echo "${LUMINA_PREFIX} ERROR: Could not load dynamic_pager."
        echo "${LUMINA_PREFIX} Try: sudo launchctl load -w ${PAGER_PLIST}"
        exit 1
    fi
}

# --- Main ---

case "${1:-status}" in
    status|--status)
        show_status
        ;;
    --disable)
        disable_swap
        ;;
    --enable)
        enable_swap
        ;;
    --help|-h)
        usage
        ;;
    *)
        echo "${LUMINA_PREFIX} Unknown argument: ${1}" >&2
        usage
        ;;
esac
