#!/usr/bin/env bash
# ============================================================================
# TrailCurrent Headwaters — network-deferred first-boot setup.
#
# Runs ONCE after the system reaches network-online.target on the first
# boot following a flash. Companion to headwaters-firstboot.service which
# runs much earlier (Before=sysinit.target) and handles the things that
# don't need the network: rootfs resize, machine-id, SSH host keys, TLS
# certificates, mount-point directories.
#
# This script is the home for anything that *does* need the network. Right
# now that's just the Python venv + `pip install -r requirements.txt`,
# which feeds the cantomqtt, discovery-mdns, and deployment-watcher
# services. Without this running successfully every Python service on the
# board crash-loops on `ModuleNotFoundError`.
#
# Idempotent: re-runs are safe. The sentinel file
# /var/lib/headwaters/.firstboot-network-done gates execution via the
# unit's ConditionPathExists.
#
# Robustness: pip is wrapped with a wait-for-DNS poll and explicit retry
# because network-online.target on Ubuntu Server can fire before DNS is
# fully reachable, and PyPI has had outages.
# ============================================================================

set -uo pipefail

LOG_TAG="headwaters-firstboot-network"
log() { echo "[firstboot-net] $*"; logger -t "$LOG_TAG" "$*"; }

mkdir -p /var/lib/headwaters

TC_USER="trailcurrent"
TC_HOME="/home/$TC_USER"
VENV_PATH="$TC_HOME/local_code/cantomqtt"
REQ_FILE="$TC_HOME/local_code/requirements.txt"

# ── 1. Wait for DNS resolution to actually work ────────────────────────────
#
# network-online.target only guarantees the kernel has a default route. On
# Ubuntu Server with NetworkManager-wait-online it usually means DNS is
# also up, but with systemd-networkd or a slow DHCP-ack it can fire
# minutes before resolv.conf is populated. Poll a known PyPI host so we
# spend our retry budget waiting for DNS rather than wasting it inside
# pip.
log "waiting for DNS to resolve pypi.org (up to 120s)"
DNS_OK=0
for i in $(seq 1 60); do
    if getent hosts pypi.org >/dev/null 2>&1; then
        log "  DNS OK after $((i * 2))s"
        DNS_OK=1
        break
    fi
    sleep 2
done
if [ "$DNS_OK" -eq 0 ]; then
    log "ERROR: DNS still unresolved after 120s — NOT marking done so next boot retries"
    exit 1
fi

# ── 2. Create venv if missing ──────────────────────────────────────────────
if [ -d "$VENV_PATH" ] && [ -x "$VENV_PATH/bin/pip" ]; then
    log "Python venv already exists at $VENV_PATH"
else
    log "creating Python venv at $VENV_PATH"
    sudo -u "$TC_USER" python3 -m venv "$VENV_PATH"
fi

# ── 3. Install requirements with explicit retry ────────────────────────────
#
# pip itself retries individual package downloads, but if the first DNS
# lookup or TLS handshake to pypi.org fails it gives up the whole batch
# without retrying the resolution. Wrap the call in a 5-attempt outer
# loop with backoff so transient PyPI hiccups don't poison the whole
# firstboot.
INSTALL_ARGS=()
if [ -f "$REQ_FILE" ]; then
    log "installing from $REQ_FILE"
    INSTALL_ARGS=(-r "$REQ_FILE")
else
    log "WARNING: $REQ_FILE missing — falling back to inline package list"
    INSTALL_ARGS=(
        paho-mqtt==2.1.0
        python-can==4.6.1
        pymongo==4.10.1
        python-dotenv==1.0.1
        packaging==25.0
        typing_extensions==4.15.0
        wrapt==1.17.3
        zeroconf==0.146.1
    )
fi

ok=0
for attempt in 1 2 3 4 5; do
    if sudo -u "$TC_USER" "$VENV_PATH/bin/pip" install --no-input -q "${INSTALL_ARGS[@]}"; then
        ok=1
        log "pip install succeeded on attempt $attempt"
        break
    fi
    backoff=$((attempt * 15))
    log "pip install attempt $attempt failed; sleeping ${backoff}s and retrying"
    sleep "$backoff"
done

if [ "$ok" -ne 1 ]; then
    log "ERROR: pip install failed after 5 attempts — NOT marking done so next boot retries"
    exit 1
fi

# ── 4. Verify imports actually work ────────────────────────────────────────
#
# Belt-and-suspenders: pip can return success on a partial install if a
# wheel cache is corrupt. Confirm every module a Python service references
# can be imported. If any fails, treat the whole firstboot-network as
# failed so the unit re-runs on next boot.
log "verifying imports"
if ! sudo -u "$TC_USER" "$VENV_PATH/bin/python" - <<'PYEOF'
import sys
required = ["can", "paho.mqtt.client", "pymongo", "dotenv",
            "packaging", "typing_extensions", "wrapt", "zeroconf"]
missing = []
for name in required:
    try:
        __import__(name)
    except ImportError as e:
        missing.append((name, str(e)))
if missing:
    for n, err in missing:
        print(f"  MISSING: {n}: {err}", file=sys.stderr)
    sys.exit(1)
print(f"  all {len(required)} imports OK")
PYEOF
then
    log "ERROR: import verification failed — services would crash-loop"
    exit 1
fi

# ── 5. Restart Python services so they pick up the now-populated venv ─────
#
# These services have been crash-looping on ModuleNotFoundError since
# boot. Reset their failure counters and start them clean. Use --no-block
# because we're still part of the boot graph and don't want to wait on
# them.
for svc in cantomqtt.service discovery-mdns.service deployment-watcher.service; do
    if systemctl is-enabled "$svc" >/dev/null 2>&1; then
        systemctl reset-failed "$svc" 2>/dev/null || true
        systemctl restart --no-block "$svc" 2>/dev/null || \
            log "WARNING: failed to restart $svc (will be picked up on its own retry cycle)"
    fi
done

# ── 6. Mark complete ───────────────────────────────────────────────────────
touch /var/lib/headwaters/.firstboot-network-done
log "first-boot (network stage) complete"
