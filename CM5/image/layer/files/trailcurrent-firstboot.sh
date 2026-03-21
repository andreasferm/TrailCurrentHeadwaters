#!/bin/bash
set -e

# TrailCurrent First-Boot Setup
#
# Runs once on first boot to configure per-device settings that require
# actual hardware (EEPROM, NVMe) or per-device uniqueness (TLS certificates).
# Controlled by trailcurrent-firstboot.service with a ConditionPathExists
# guard so it only runs once.
#
# Storage layout after first boot:
#   eMMC (/)          - OS, packages, Docker engine, config, scripts
#   NVMe (/mnt/nvme)  - Docker images/volumes, app data, Python venv
#     /mnt/nvme/docker     -> Docker data-root (images, containers, volumes)
#     /mnt/nvme/data       -> symlinked from ~/data (keys, tileserver, node-red)
#     /mnt/nvme/local_code -> symlinked from ~/local_code (venv, Python scripts)

LOG_TAG="trailcurrent-firstboot"
log() { echo "$1"; logger -t "$LOG_TAG" "$1"; }

NVME_MOUNT="/mnt/nvme"

# Detect the first non-root user (created by rpi-image-gen user layer)
TC_USER=$(getent passwd 1000 | cut -d: -f1)
if [ -z "$TC_USER" ]; then
    log "ERROR: No user with UID 1000 found"
    exit 1
fi
TC_HOME="/home/$TC_USER"

log "Starting first-boot setup for user: $TC_USER"

# -------------------------------------------
# 1. Configure NVMe storage
# -------------------------------------------
log "Configuring NVMe storage..."

# Find the NVMe block device
NVME_DEV=""
for dev in /dev/nvme0n1 /dev/nvme1n1; do
    if [ -b "$dev" ]; then
        NVME_DEV="$dev"
        break
    fi
done

if [ -z "$NVME_DEV" ]; then
    log "WARNING: No NVMe device found. Using eMMC for all storage."
    log "  Docker data-root and app data will remain on eMMC."
    log "  To use NVMe later, install a drive and re-run this script:"
    log "    sudo rm /var/lib/trailcurrent/.firstboot-done"
    log "    sudo systemctl start trailcurrent-firstboot"

    # Fall back: point Docker to local storage and create dirs on eMMC
    cat > /etc/docker/daemon.json << 'EOF'
{
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "10m",
    "max-file": "3"
  }
}
EOF
    # Remove NVMe dependency from Docker since there is no NVMe
    rm -f /etc/systemd/system/docker.service.d/nvme-dependency.conf
    systemctl daemon-reload

    # Create directories directly in the home directory
    sudo -u "$TC_USER" mkdir -p "$TC_HOME/local_code"
    sudo -u "$TC_USER" mkdir -p "$TC_HOME/data/keys"
    sudo -u "$TC_USER" mkdir -p "$TC_HOME/data/tileserver"
    sudo -u "$TC_USER" mkdir -p "$TC_HOME/data/node-red"
else
    log "  Found NVMe device: $NVME_DEV"

    # Check if already partitioned
    NVME_PART="${NVME_DEV}p1"
    if [ -b "$NVME_PART" ]; then
        log "  NVMe already has a partition: $NVME_PART"
    else
        log "  Partitioning $NVME_DEV..."
        parted -s "$NVME_DEV" mklabel gpt
        parted -s "$NVME_DEV" mkpart primary ext4 1MiB 100%
        # Wait for the kernel to register the new partition
        partprobe "$NVME_DEV"
        sleep 2
        log "  Created partition $NVME_PART"
    fi

    # Format if not already formatted
    if ! blkid "$NVME_PART" | grep -q 'TYPE="ext4"'; then
        log "  Formatting $NVME_PART as ext4..."
        mkfs.ext4 -q -L trailcurrent "$NVME_PART"
        log "  Formatted"
    else
        log "  $NVME_PART already formatted as ext4"
    fi

    # Mount the NVMe
    mkdir -p "$NVME_MOUNT"
    if ! mountpoint -q "$NVME_MOUNT"; then
        mount "$NVME_PART" "$NVME_MOUNT"
        log "  Mounted $NVME_PART at $NVME_MOUNT"
    fi

    # Add fstab entry for automatic mount on future boots
    NVME_UUID=$(blkid -s UUID -o value "$NVME_PART")
    if ! grep -q "$NVME_UUID" /etc/fstab; then
        echo "UUID=$NVME_UUID  $NVME_MOUNT  ext4  defaults,noatime  0  2" >> /etc/fstab
        log "  Added fstab entry (UUID=$NVME_UUID)"
    fi

    # Create directory structure on NVMe
    mkdir -p "$NVME_MOUNT/docker"
    mkdir -p "$NVME_MOUNT/data/keys"
    mkdir -p "$NVME_MOUNT/data/tileserver"
    mkdir -p "$NVME_MOUNT/data/node-red"
    mkdir -p "$NVME_MOUNT/local_code"
    chown -R "$TC_USER:$TC_USER" "$NVME_MOUNT/data" "$NVME_MOUNT/local_code"

    # Symlink ~/data -> /mnt/nvme/data
    # Symlink ~/local_code -> /mnt/nvme/local_code
    # Remove any existing directories first (they were empty from image)
    rm -rf "$TC_HOME/data" "$TC_HOME/local_code"
    sudo -u "$TC_USER" ln -s "$NVME_MOUNT/data" "$TC_HOME/data"
    sudo -u "$TC_USER" ln -s "$NVME_MOUNT/local_code" "$TC_HOME/local_code"

    log "  NVMe storage configured:"
    log "    $NVME_MOUNT/docker     -> Docker images, containers, volumes"
    log "    $TC_HOME/data          -> $NVME_MOUNT/data (keys, tileserver, node-red)"
    log "    $TC_HOME/local_code    -> $NVME_MOUNT/local_code (venv, scripts)"
fi

# -------------------------------------------
# 2. Configure EEPROM for auto-boot on power
# -------------------------------------------
log "Configuring EEPROM for auto-boot on power..."

if command -v rpi-eeprom-config > /dev/null 2>&1; then
    EEPROM_CONFIG=$(rpi-eeprom-config 2>/dev/null || true)

    if echo "$EEPROM_CONFIG" | grep -q "WAKE_ON_GPIO=0"; then
        log "  EEPROM auto-boot already configured"
    else
        EEPROM_TMP=$(mktemp)
        echo "$EEPROM_CONFIG" \
            | grep -v "^WAKE_ON_GPIO=" \
            | grep -v "^POWER_OFF_ON_HALT=" \
            | grep -v "^BOOT_ORDER=" \
            > "$EEPROM_TMP"
        echo "WAKE_ON_GPIO=0" >> "$EEPROM_TMP"
        echo "POWER_OFF_ON_HALT=1" >> "$EEPROM_TMP"
        echo "BOOT_ORDER=0xfe1" >> "$EEPROM_TMP"
        rpi-eeprom-config --apply "$EEPROM_TMP"
        rm -f "$EEPROM_TMP"
        log "  EEPROM configured: boot eMMC first, auto-boot on power, full power-off on halt"
    fi
else
    log "  rpi-eeprom-config not found, skipping EEPROM setup"
fi

# -------------------------------------------
# 3. Generate TLS/SSL certificates
# -------------------------------------------
log "Generating TLS/SSL certificates..."

KEYS_DIR="$TC_HOME/data/keys"
TLS_HOSTNAME="$(hostname).local"
VALIDITY_DAYS=3650

if [ -f "$KEYS_DIR/server.crt" ] && [ -f "$KEYS_DIR/server.key" ]; then
    log "  Certificates already exist, skipping"
else
    # CA key + cert
    openssl genrsa -out "$KEYS_DIR/ca.key" 2048 2>/dev/null
    openssl req -new -x509 -days $VALIDITY_DAYS \
        -key "$KEYS_DIR/ca.key" \
        -out "$KEYS_DIR/ca.crt" \
        -subj "/C=US/ST=State/L=City/O=TrailCurrent/OU=Engineering/CN=TrailCurrent-CA" 2>/dev/null
    cp "$KEYS_DIR/ca.crt" "$KEYS_DIR/ca.pem"

    # Server key + CSR + signed cert
    openssl genrsa -out "$KEYS_DIR/server.key" 2048 2>/dev/null
    SAN_LIST="DNS:$TLS_HOSTNAME,IP:127.0.0.1,IP:::1"
    openssl req -new \
        -key "$KEYS_DIR/server.key" \
        -out "$KEYS_DIR/server.csr" \
        -subj "/C=US/ST=State/L=City/O=TrailCurrent/OU=Engineering/CN=$TLS_HOSTNAME" \
        -addext "subjectAltName=$SAN_LIST" 2>/dev/null
    openssl x509 -req -days $VALIDITY_DAYS \
        -in "$KEYS_DIR/server.csr" \
        -CA "$KEYS_DIR/ca.crt" \
        -CAkey "$KEYS_DIR/ca.key" \
        -CAcreateserial \
        -out "$KEYS_DIR/server.crt" \
        -copy_extensions copyall 2>/dev/null

    # Clean up temp files and set permissions
    rm -f "$KEYS_DIR/server.csr" "$KEYS_DIR/ca.srl"
    chmod 644 "$KEYS_DIR"/*
    chown "$TC_USER:$TC_USER" "$KEYS_DIR"/*

    log "  Certificates generated for $TLS_HOSTNAME (valid 10 years)"
fi

# -------------------------------------------
# 4. Set up Python virtual environment
# -------------------------------------------
log "Setting up Python virtual environment..."

VENV_PATH="$TC_HOME/local_code/cantomqtt"

if [ -d "$VENV_PATH" ]; then
    log "  Virtual environment already exists"
else
    sudo -u "$TC_USER" python3 -m venv "$VENV_PATH"
    log "  Created virtual environment at $VENV_PATH"
fi

# Install base Python dependencies (full list comes with deployment)
sudo -u "$TC_USER" "$VENV_PATH/bin/pip" install -q \
    paho-mqtt==2.1.0 \
    python-can==4.6.1 \
    pymongo==4.10.1 \
    python-dotenv==1.0.1 \
    packaging==25.0 \
    typing_extensions==4.15.0 \
    wrapt==1.17.3

log "  Python dependencies installed"

# -------------------------------------------
# Done
# -------------------------------------------
log "First-boot setup complete."
log ""
log "Storage layout:"
if [ -n "$NVME_DEV" ]; then
    log "  eMMC (/)           : OS, packages, Docker engine, config"
    log "  NVMe ($NVME_MOUNT) : Docker data, app data, Python venv"
else
    log "  eMMC only (no NVMe detected)"
fi
log ""
log "A reboot is recommended for EEPROM changes to take effect."
