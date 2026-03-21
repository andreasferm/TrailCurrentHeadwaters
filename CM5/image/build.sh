#!/bin/bash
set -e

# TrailCurrent CM5 Base Image Builder
#
# Builds a custom Raspberry Pi OS image for the CM5 with all TrailCurrent
# base system configuration baked in (power savings, CAN bus, Docker, etc.)
# The image is flashed to the CM5's eMMC. On first boot, the NVMe drive
# is automatically partitioned, formatted, and mounted for Docker and
# application data storage.
#
# Prerequisites:
#   - Debian/Ubuntu build host (arm64 native or x86_64 with QEMU)
#   - Run with sudo (rpi-image-gen requires root for chroot operations)
#
# Usage:
#   sudo ./build.sh [username] [password]
#
# Arguments:
#   username  - Default login user (default: trailcurrent)
#   password  - Default login password (default: trailcurrent)
#
# The password is hashed before being passed to rpi-image-gen, bypassing
# its built-in password complexity rules.
#
# Output:
#   ../rpi-image-gen/work/image-trailcurrent-cm5-base/trailcurrent-cm5-base.img

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RPIIG_DIR="$SCRIPT_DIR/../rpi-image-gen"

TC_USER="${1:-trailcurrent}"
TC_PASS="${2:-trailcurrent}"

# Hash the password so we can use IGconf_device_user1passhash
# instead of user1pass (which has strict complexity validation)
TC_PASSHASH=$(openssl passwd -6 "$TC_PASS")

# Clone rpi-image-gen if not present
if [ ! -d "$RPIIG_DIR" ]; then
    echo "Cloning rpi-image-gen..."
    git clone https://github.com/raspberrypi/rpi-image-gen.git "$RPIIG_DIR"
fi

# Install build dependencies if not already done
if [ ! -f "$RPIIG_DIR/.deps_installed" ]; then
    echo "Installing build dependencies..."
    "$RPIIG_DIR/install_deps.sh"
    touch "$RPIIG_DIR/.deps_installed"
fi

# Set target architecture for cross-compilation on x86_64 hosts.
# On native arm64 hosts this is harmless (TOOLCHAIN_MODE=native).
export ARCH=arm64

# Build the image
cd "$RPIIG_DIR"
./rpi-image-gen build \
    -S "$SCRIPT_DIR" \
    -c trailcurrent-cm5-base.yaml \
    -- \
    IGconf_device_user1="$TC_USER" \
    IGconf_device_user1passhash="$TC_PASSHASH"

IMG_PATH="$RPIIG_DIR/work/image-trailcurrent-cm5-base/trailcurrent-cm5-base.img"

echo ""
echo "================================================"
echo "Image built successfully!"
echo "================================================"
echo ""
echo "Output: $IMG_PATH"
echo ""
echo "Flash to CM5 eMMC:"
echo "  1. Fit the EMMC_DISABLE jumper on the carrier board"
echo "  2. Connect the CM5 carrier USB-C to this computer"
echo "  3. Apply power to the carrier board"
echo "  4. sudo ../usbboot/rpiboot -d mass-storage-gadget64"
echo "  5. Wait for the eMMC to appear as /dev/sdX (check dmesg or lsblk)"
echo "  6. sudo dd if=$IMG_PATH of=/dev/sdX bs=4M status=progress"
echo "  7. sync"
echo "  8. Remove EMMC_DISABLE jumper, disconnect USB, power cycle"
echo ""
echo "On first boot the CM5 will automatically:"
echo "  - Partition and format the NVMe drive"
echo "  - Configure EEPROM for auto-boot on power"
echo "  - Generate TLS certificates"
echo "  - Set up the Python virtual environment"
echo ""
echo "See CM5/SETUP.md for the full getting-started guide."
echo ""
