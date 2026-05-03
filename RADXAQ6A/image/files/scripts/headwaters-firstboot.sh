#!/usr/bin/env bash
# ============================================================================
# TrailCurrent Headwaters — Q6A first-boot setup
#
# Runs once on the first boot after flashing the golden image, before Docker
# starts. Regenerates per-board identity, expands root to fill the NVMe,
# generates TLS certs, and sets up the Python venv used by the host-side
# CAN-to-MQTT / discovery-mdns / deployment-watcher services.
#
# Idempotent under repeated invocation thanks to the .firstboot-done sentinel
# (created on success — see the unit file).
# ============================================================================

set -uo pipefail

LOG_TAG="headwaters-firstboot"
log() { echo "[firstboot] $*"; logger -t "$LOG_TAG" "$*"; }

mkdir -p /var/lib/headwaters

TC_USER="trailcurrent"
TC_HOME="/home/$TC_USER"

# ── 1. Expand the root partition to fill the NVMe ──────────────────────────
#
# This MUST run before anything else. The flashed image ships with ~30 GB
# of free space inside a 60 GB partition; everything that follows (cert
# generation, pip install, Docker activity) needs more headroom and assumes
# the rootfs has been expanded to fill the underlying NVMe. If a later
# step fails and we exit non-zero, the sentinel file is NOT created and
# the next boot will retry — but resize first ensures we never get stuck
# in a "disk full → can't even log → mysterious hang" loop.
#
# Do NOT silence stderr on growpart/resize2fs — if expansion fails the board
# works but runs out of disk as soon as Docker images are pulled, and silent
# failure is a nightmare to debug post-flash. Log the actual tool output.

ROOT_DEV=$(findmnt -n -o SOURCE / || true)
ROOT_DISK=$(lsblk -ndo PKNAME "$ROOT_DEV" 2>&1 || true)

if [[ -z "$ROOT_DEV" || -z "$ROOT_DISK" ]]; then
    log "ERROR: could not determine root device (ROOT_DEV='$ROOT_DEV' ROOT_DISK='$ROOT_DISK')"
    log "  findmnt output:"; findmnt -n -o SOURCE / 2>&1 | sed 's/^/    /' || true
    log "  lsblk output:";    lsblk 2>&1 | sed 's/^/    /' || true
else
    PART_NUM=$(echo "$ROOT_DEV" | grep -oP '\d+$' || true)
    if [[ -z "$PART_NUM" ]]; then
        log "ERROR: could not parse partition number from $ROOT_DEV"
    else
        log "expanding /dev/${ROOT_DISK} partition ${PART_NUM} to fill disk"
        # growpart returns 0 on change, 1 on no-change, other on error
        gp_out=$(growpart "/dev/${ROOT_DISK}" "${PART_NUM}" 2>&1) || gp_rc=$? && gp_rc=${gp_rc:-0}
        log "  growpart rc=$gp_rc: $gp_out"
        if [[ "$gp_rc" -gt 1 ]]; then
            log "ERROR: growpart failed — NOT marking firstboot done so next boot retries"
            exit 1
        fi
        rs_out=$(resize2fs "$ROOT_DEV" 2>&1) || rs_rc=$? && rs_rc=${rs_rc:-0}
        log "  resize2fs rc=$rs_rc: $(echo "$rs_out" | head -5 | tr '\n' ' ')"
        if [[ "$rs_rc" -ne 0 ]]; then
            log "ERROR: resize2fs failed — NOT marking firstboot done so next boot retries"
            exit 1
        fi
        df_line=$(df -h "$ROOT_DEV" | tail -1)
        log "  root filesystem now: $df_line"
    fi
fi

# NOTE: an earlier revision of this script patched BootAskValid + ConIn
# UEFI variables here to disable the embloader boot-menu prompt. That
# approach was empirically proven not to work on Q6A: the SPI NOR
# firmware re-seeds both variables on every boot, so any change made
# from Linux is reverted before embloader reads them. The actual fix
# is rsdk hook 19d, which replaces /EFI/BOOT/BOOTAA64.EFI with a
# patched embloader 0.4 that skips the menu when timeout=0 (see
# RADXAQ6A/image/embloader/patches/0001-headwaters-autoboot-on-
# timeout-zero.patch). No runtime UEFI-variable manipulation needed.

# ── 2. Regenerate machine-id (was cleared in the golden image) ─────────────
if [[ ! -s /etc/machine-id ]]; then
    systemd-machine-id-setup
    log "regenerated /etc/machine-id"
fi

# ── 3. SSH host keys — pre-generated in the chroot; regenerate if missing ──
if ! ls /etc/ssh/ssh_host_*_key &>/dev/null; then
    dpkg-reconfigure -f noninteractive openssh-server
    log "regenerated SSH host keys"
fi

# ── 3b. Belt-and-suspenders SSH enablement ─────────────────────────────────
#
# Even though hook 8 of the image build enables ssh.service and runs the
# ssh.socket dance, a Radxa package may still disable ssh on first boot
# (rsetup.service running before.txt is the known culprit; hook 14 masks it,
# but a future Radxa release could introduce a new mechanism). Applying the
# full dance here unconditionally means first boot ALWAYS wins.
#
# CRITICAL: `systemctl start ssh.service` MUST use --no-block here. This
# unit runs Before=sysinit.target, and ssh.service transitively requires
# basic.target → sysinit.target. A blocking `start` deadlocks: we wait for
# ssh, ssh waits for sysinit, sysinit waits for us, until TimeoutStartSec
# fires and the whole script is killed mid-run. --no-block enqueues the
# start job and returns immediately; ssh then comes up naturally once
# sysinit.target is reached after this service finishes.
rm -f /etc/systemd/system/ssh.service.requires/ssh.socket
systemctl disable ssh.socket 2>/dev/null || true
systemctl mask    ssh.socket 2>/dev/null || true
systemctl enable  ssh.service 2>/dev/null || true
systemctl start --no-block ssh.service 2>/dev/null || true
log "ssh.service enabled and start enqueued (will activate after sysinit.target)"

# ── 4. Docker bind-mount targets (must exist before docker.service) ────────
install -d -m 755 -o "$TC_USER" -g "$TC_USER" "$TC_HOME/data/keys"
install -d -m 755 -o "$TC_USER" -g "$TC_USER" "$TC_HOME/data/tileserver"
install -d -m 755 -o "$TC_USER" -g "$TC_USER" "$TC_HOME/data/firmware"
install -d -m 755 -o "$TC_USER" -g "$TC_USER" "$TC_HOME/data/deployments"
install -d -m 755 -o "$TC_USER" -g "$TC_USER" "$TC_HOME/local_code"

# ── 5. Generate TLS/SSL certificates (per-device uniqueness) ───────────────
KEYS_DIR="$TC_HOME/data/keys"
TLS_HOSTNAME="$(hostname).local"
CA_VALIDITY_DAYS=3650
SERVER_VALIDITY_DAYS=825   # Apple requires server certs ≤ 825 days

if [ -f "$KEYS_DIR/server.crt" ] && [ -f "$KEYS_DIR/server.key" ]; then
    log "TLS certificates already exist, skipping"
else
    log "generating TLS/SSL certificates for $TLS_HOSTNAME"

    LOCAL_IPS=$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^[0-9]+\.' | grep -v '^127\.' || true)
    SAN_LIST="DNS:$TLS_HOSTNAME,IP:127.0.0.1,IP:::1"
    if [ -n "$LOCAL_IPS" ]; then
        while IFS= read -r ip; do
            [ -n "$ip" ] && SAN_LIST="$SAN_LIST,IP:$ip"
        done <<< "$LOCAL_IPS"
    fi

    cat > "$KEYS_DIR/_ca.cnf" <<'CAEOF'
[req]
distinguished_name = req_dn
x509_extensions = v3_ca
prompt = no

[req_dn]
C = US
ST = State
L = City
O = TrailCurrent
OU = Engineering
CN = TrailCurrent-CA

[v3_ca]
basicConstraints = critical, CA:true
keyUsage = critical, keyCertSign, cRLSign
subjectKeyIdentifier = hash
CAEOF

    openssl genrsa -out "$KEYS_DIR/ca.key" 2048 2>/dev/null
    openssl req -new -x509 -days $CA_VALIDITY_DAYS \
        -key "$KEYS_DIR/ca.key" \
        -out "$KEYS_DIR/ca.crt" \
        -config "$KEYS_DIR/_ca.cnf"
    cp "$KEYS_DIR/ca.crt" "$KEYS_DIR/ca.pem"

    cat > "$KEYS_DIR/_server.cnf" <<SRVEOF
[req]
distinguished_name = req_dn
req_extensions = v3_server
prompt = no

[req_dn]
C = US
ST = State
L = City
O = TrailCurrent
OU = Engineering
CN = $TLS_HOSTNAME

[v3_server]
basicConstraints = critical, CA:false
keyUsage = critical, digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = $SAN_LIST
SRVEOF

    openssl genrsa -out "$KEYS_DIR/server.key" 2048 2>/dev/null
    openssl req -new \
        -key "$KEYS_DIR/server.key" \
        -out "$KEYS_DIR/server.csr" \
        -config "$KEYS_DIR/_server.cnf"
    openssl x509 -req -days $SERVER_VALIDITY_DAYS \
        -in "$KEYS_DIR/server.csr" \
        -CA "$KEYS_DIR/ca.crt" \
        -CAkey "$KEYS_DIR/ca.key" \
        -CAcreateserial \
        -out "$KEYS_DIR/server.crt" \
        -extfile "$KEYS_DIR/_server.cnf" \
        -extensions v3_server

    rm -f "$KEYS_DIR/server.csr" "$KEYS_DIR/ca.srl" "$KEYS_DIR/_ca.cnf" "$KEYS_DIR/_server.cnf"
    chmod 644 "$KEYS_DIR"/*
    chown "$TC_USER:$TC_USER" "$KEYS_DIR"/*
    log "TLS certificates generated (CA 10y, server ${SERVER_VALIDITY_DAYS}d)"
fi

# ── 6. Mark early-firstboot complete ───────────────────────────────────────
#
# The Python venv creation and pip install used to live here as steps 6/7.
# They've been moved to /usr/local/sbin/headwaters-firstboot-network.sh
# (unit: headwaters-firstboot-network.service) which runs after
# network-online.target, because pip needs DNS + HTTPS to reach PyPI and
# this unit runs Before=sysinit.target — way before networking is up.
# Empirical proof: every fresh flash had its venv ship empty because pip
# raised "Temporary failure in name resolution" and the script logged a
# WARNING but marked firstboot done anyway. Every Python service then
# crash-looped on ModuleNotFoundError until someone SSHed in to run pip
# manually. The split fixes this for good.
touch /var/lib/headwaters/.firstboot-done
log "first-boot (early stage) complete — waiting for network-online so"
log "  headwaters-firstboot-network.service can populate the Python venv"
