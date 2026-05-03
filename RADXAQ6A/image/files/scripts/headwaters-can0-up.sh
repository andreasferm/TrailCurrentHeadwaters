#!/usr/bin/env bash
# ============================================================================
# Bring up can0 (Waveshare RS485 CAN HAT, MCP2515 on SPI12/CS0).
#
# Why a script instead of `ConditionPathExists=/sys/class/net/can0`:
# the MCP2515 SPI driver needs ~1-3 s after kernel boot to bind and
# create the netdev. systemd evaluates the condition once at service
# start, which can fire before that bind completes — leading to the
# service being silently skipped and the interface staying down forever
# despite the HAT being installed and working. Empirical: observed on
# the Q6A on most cold boots.
#
# Why we don't use Wants=sys-subsystem-net-devices-can0.device: that
# blocks the boot graph for ~90 s on systems where the HAT isn't
# present (development, bench rework). Polling here lets us succeed
# quickly when the HAT IS present without holding up boot when it
# isn't.
#
# Behavior:
#   * HAT present, MCP2515 binds within DEADLINE_SEC: configure can0
#     at 500 kbit/s, bring it up, exit 0.
#   * HAT present but already up: no-op, exit 0.
#   * HAT absent (no /sys/class/net/can0 after DEADLINE_SEC): log a
#     line and exit 0. Service is "started" but did nothing — keeps
#     boot fast and avoids spurious failure noise.
# ============================================================================

set -uo pipefail

LOG_TAG="headwaters-can0"
log() { echo "[can0] $*"; logger -t "$LOG_TAG" "$*"; }

DEADLINE_SEC=30
BITRATE=500000
IFACE=can0

# Poll for /sys/class/net/can0 with a 0.5 s tick.
elapsed=0
while [ ! -e "/sys/class/net/$IFACE" ]; do
    if [ "$elapsed" -ge "$DEADLINE_SEC" ]; then
        log "/sys/class/net/$IFACE did not appear within ${DEADLINE_SEC}s — HAT not installed or MCP2515 driver did not bind. Exiting cleanly."
        exit 0
    fi
    sleep 0.5
    elapsed=$((elapsed + 1))
done

# Wait for any upstream initialization (debouncing). 1 s of jitter lets
# the SPI clock settle after the driver bind.
sleep 1

# If already up, nothing to do.
state=$(cat "/sys/class/net/$IFACE/operstate" 2>/dev/null || echo "unknown")
flags=$(cat "/sys/class/net/$IFACE/flags" 2>/dev/null || echo "0x0")
if [ "$state" = "up" ]; then
    log "$IFACE already up (operstate=$state flags=$flags) — no-op"
    exit 0
fi

log "configuring $IFACE at $BITRATE bps and bringing up"
if ! ip link set "$IFACE" type can bitrate "$BITRATE"; then
    log "ERROR: failed to set bitrate on $IFACE"
    exit 1
fi
if ! ip link set "$IFACE" up; then
    log "ERROR: failed to bring up $IFACE"
    exit 1
fi
log "$IFACE up @ $BITRATE bps"
