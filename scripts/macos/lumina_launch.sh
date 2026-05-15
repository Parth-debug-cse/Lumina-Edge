#!/bin/bash
# chmod +x scripts/macos/*.sh
#
# scripts/macos/lumina_launch.sh
# Master pre-flight launcher for Lumina Edge on macOS (Apple Silicon).
#
# Runs scripts 1–4 in sequence, then launches the Lumina Edge inference
# framework. All scripts live in the same directory.
#
# == README — Script Usage Reference ==
#
# scripts/macos/purge_and_prep.sh
#   sudo ./purge_and_prep.sh
#   Flush disk cache, disable Spotlight, stop Time Machine, purge memory.
#
# scripts/macos/kill_memory_hogs.sh
#   ./kill_memory_hogs.sh           (user processes)
#   sudo ./kill_memory_hogs.sh      (also stops system daemons)
#   Kills known memory-hungry background processes.
#
# scripts/macos/ram_monitor.sh
#   ./ram_monitor.sh
#   Live RAM dashboard — runs in a second terminal, updates every 5 s.
#
# scripts/macos/swap_and_swap_off.sh
#   ./swap_and_swap_off.sh              — status check
#   ./swap_and_swap_off.sh --disable    — disable swap for session
#   ./swap_and_swap_off.sh --enable     — re-enable swap
#
# scripts/macos/lumina_launch.sh
#   ./lumina_launch.sh
#   Master pre-flight: runs hogs → purge → swap-status → launch Lumina.
#   Override LUMINA_DIR env var to change installation path
#   (default: $HOME/lumina-edge).
#
# == End README ==

set -e

LUMINA_PREFIX="[lumina]"

# Resolve the directory where this script lives (supports symlinks)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Default install location; can be overridden via env var
LUMINA_DIR="${LUMINA_DIR:-${HOME}/lumina-edge}"

echo ""
echo "==============================================="
echo "   Lumina Edge — macOS pre-flight"
echo "   $(date)"
echo "==============================================="
echo ""

# ---- Step 1: Kill memory hogs ----
echo "${LUMINA_PREFIX} [Step 1/4] Killing memory-hungry background processes..."
if [[ -x "${SCRIPT_DIR}/kill_memory_hogs.sh" ]]; then
    "${SCRIPT_DIR}/kill_memory_hogs.sh" || \
        echo "${LUMINA_PREFIX} WARNING: kill_memory_hogs.sh exited with non-zero status."
else
    echo "${LUMINA_PREFIX} WARNING: kill_memory_hogs.sh not found or not executable."
fi
echo ""

# ---- Step 2: Purge and prep (needs sudo) ----
echo "${LUMINA_PREFIX} [Step 2/4] Running cache flush and memory purge..."
if [[ -x "${SCRIPT_DIR}/purge_and_prep.sh" ]]; then
    if [[ $EUID -eq 0 ]]; then
        "${SCRIPT_DIR}/purge_and_prep.sh"
    else
        echo "${LUMINA_PREFIX}  purge_and_prep.sh requires sudo. Attempting elevated run..."
        sudo "${SCRIPT_DIR}/purge_and_prep.sh" || \
            echo "${LUMINA_PREFIX} WARNING: purge_and_prep.sh failed (try: sudo ${0})"
    fi
else
    echo "${LUMINA_PREFIX} WARNING: purge_and_prep.sh not found or not executable."
fi
echo ""

# ---- Step 3: Check swap status ----
echo "${LUMINA_PREFIX} [Step 3/4] Checking swap status..."
if [[ -x "${SCRIPT_DIR}/swap_and_swap_off.sh" ]]; then
    "${SCRIPT_DIR}/swap_and_swap_off.sh" || \
        echo "${LUMINA_PREFIX} WARNING: swap_and_swap_off.sh exited with non-zero status."
else
    echo "${LUMINA_PREFIX} WARNING: swap_and_swap_off.sh not found or not executable."
fi
echo ""

# ---- Step 4: Print estimated RAM available to MLX ----
echo "${LUMINA_PREFIX} [Step 4/4] Estimating RAM available to MLX..."
PAGE_SIZE=16384
FREE_PAGES=$(vm_stat | awk '/pages free/ {gsub(/\./,"",$NF); print $NF}')
INACTIVE_PAGES=$(vm_stat | awk '/pages inactive/ {gsub(/\./,"",$NF); print $NF}')
AVAILABLE_MB=$(( (FREE_PAGES + INACTIVE_PAGES) * PAGE_SIZE / 1048576 ))
echo "${LUMINA_PREFIX}  Estimated available to MLX (free + inactive): ${AVAILABLE_MB} MB"
echo ""

# ---- Launch Lumina Edge ----
echo "${LUMINA_PREFIX} === Launching Lumina Edge ==="
echo "${LUMINA_PREFIX}  LUMINA_DIR = ${LUMINA_DIR}"
echo ""

# Note: start.sh and scripts/start_macos.sh have been removed.
# Use the root-level mac.sh instead:
#   cd /path/to/lumina-edge && ./mac.sh
if [[ -x "${LUMINA_DIR}/mac.sh" ]]; then
    echo "${LUMINA_PREFIX} Found: ${LUMINA_DIR}/mac.sh"
    exec "${LUMINA_DIR}/mac.sh"
else
    echo "${LUMINA_PREFIX} ERROR: Could not find a Lumina Edge entry point." >&2
    echo "${LUMINA_PREFIX} Looked in:" >&2
    echo "${LUMINA_PREFIX}   - ${LUMINA_DIR}/mac.sh" >&2
    echo "${LUMINA_PREFIX}" >&2
    echo "${LUMINA_PREFIX} Run mac.sh from the project root:" >&2
    echo "${LUMINA_PREFIX}   cd /path/to/lumina-edge && ./mac.sh" >&2
    exit 1
fi
