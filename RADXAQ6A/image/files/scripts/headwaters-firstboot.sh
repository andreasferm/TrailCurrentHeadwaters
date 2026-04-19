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

# ── 1. Regenerate machine-id (was cleared in the golden image) ──────────────
if [[ ! -s /etc/machine-id ]]; then
    systemd-machine-id-setup
    log "regenerated /etc/machine-id"
fi

# ── 2. SSH host keys — pre-generated in the chroot; regenerate if missing ──
if ! ls /etc/ssh/ssh_host_*_key &>/dev/null; then
    dpkg-reconfigure -f noninteractive openssh-server
    log "regenerated SSH host keys"
fi

# ── 2b. Belt-and-suspenders SSH enablement ──────────────────────────────────
#
# Even though hook 8 of the image build enables ssh.service and runs the
# ssh.socket dance, a Radxa package may still disable ssh on first boot
# (rsetup.service running before.txt is the known culprit; hook 14 masks it,
# but a future Radxa release could introduce a new mechanism). Applying the
# full dance here unconditionally means first boot ALWAYS wins.
#
# This is the fix Peregrine should have had sooner — three days of build
# cycles were spent discovering that packaging-level fixes are insufficient
# and must be backed up by a runtime re-assert on first boot.
rm -f /etc/systemd/system/ssh.service.requires/ssh.socket
systemctl disable ssh.socket 2>/dev/null || true
systemctl mask    ssh.socket 2>/dev/null || true
systemctl enable  ssh.service 2>/dev/null || true
systemctl start   ssh.service 2>/dev/null || true
if systemctl is-active ssh.service >/dev/null 2>&1; then
    log "ssh.service re-enabled and running"
else
    log "WARNING: ssh.service did not start — check 'systemctl status ssh.service'"
fi

# ── 3. Expand the root partition to fill the NVMe ──────────────────────────
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

# ── 6. Python venv for CAN-to-MQTT / discovery-mdns / deployment-watcher ──
VENV_PATH="$TC_HOME/local_code/cantomqtt"
if [ -d "$VENV_PATH" ]; then
    log "Python venv already exists"
else
    sudo -u "$TC_USER" python3 -m venv "$VENV_PATH"
    log "created Python venv at $VENV_PATH"
fi

if [ -f "$TC_HOME/local_code/requirements.txt" ]; then
    sudo -u "$TC_USER" "$VENV_PATH/bin/pip" install -q \
        -r "$TC_HOME/local_code/requirements.txt" || \
        log "WARNING: requirements.txt install reported errors"
else
    sudo -u "$TC_USER" "$VENV_PATH/bin/pip" install -q \
        paho-mqtt==2.1.0 \
        python-can==4.6.1 \
        pymongo==4.10.1 \
        python-dotenv==1.0.1 \
        packaging==25.0 \
        typing_extensions==4.15.0 \
        wrapt==1.17.3 || \
        log "WARNING: fallback pip install reported errors"
fi
log "Python dependencies installed"

# ── 7. Mark complete ───────────────────────────────────────────────────────
touch /var/lib/headwaters/.firstboot-done
log "first-boot complete"
