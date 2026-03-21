# CM5 Setup Guide

This guide covers everything needed to go from a bare Compute Module 5 to a
running TrailCurrent Headwaters unit.

## Hardware Requirements

- Raspberry Pi Compute Module 5 (with eMMC)
- CM5 carrier board (IO Board or custom) with:
  - USB-C port for flashing
  - EMMC_DISABLE jumper (sometimes labelled "nRPIBOOT" or "Disable eMMC Boot")
  - NVMe M.2 slot (M-key or B+M-key)
- NVMe SSD (any capacity — 128 GB+ recommended)
- TrailCurrent CAN Hat (MCP2515, SPI0/CE0, 12 MHz crystal, GPIO25 interrupt)
- Ethernet connection
- A Linux computer for building and flashing (Debian/Ubuntu, arm64 or x86_64)

## Storage Architecture

The CM5 uses a split-storage layout to balance reliability with performance:

| Drive | Mount | Contents |
|-------|-------|----------|
| eMMC  | `/`   | OS, system packages, Docker engine, deployment scripts, config |
| NVMe  | `/mnt/nvme` | Docker images and volumes, MongoDB data, map tiles, Node-RED data, Python venv |

The eMMC holds the OS and is small but reliable. The NVMe holds all large and
frequently-written data (Docker, databases, tiles). Symlinks make this
transparent to the application:

```
~/data       -> /mnt/nvme/data        (keys, tileserver, node-red)
~/local_code -> /mnt/nvme/local_code  (Python venv, CAN-to-MQTT scripts)
```

Docker's `data-root` is set to `/mnt/nvme/docker`, so all container images,
running containers, and named volumes (like `mongodb-data`) live on the NVMe.

The NVMe is **automatically** partitioned, formatted (ext4), and mounted on
first boot. No manual preparation is needed — just install the drive before
powering on.

> **No NVMe?** The first-boot script detects this and falls back to eMMC-only
> storage. Everything works, just slower and with less space.

## Quick Start

### 1. Build the rpiboot Tool

The `rpiboot` tool puts the CM5 into USB mass storage mode so you can flash
the eMMC from your computer. The version from APT has known issues with CM5,
so we build from source:

```bash
git clone https://github.com/raspberrypi/usbboot CM5/usbboot
cd CM5/usbboot
git submodule init && git submodule update
make
```

This produces the `rpiboot` binary in `CM5/usbboot/`. The submodule step
fetches the EEPROM firmware files needed for both flashing and
[EEPROM recovery](#eeprom-recovery-boot_order-or-firmware-errors).

### 2. Build the Base Image

The base image includes the OS, Docker, CAN bus configuration, power
optimizations, and all system dependencies. It does **not** include the
application stack (containers, flows, config) — those come from `deploy.sh`.

```bash
cd CM5/image
sudo ./build.sh myuser mypassword
```

Arguments:
- First argument: login username (default: `trailcurrent`)
- Second argument: login password (default: `trailcurrent`)

The password is hashed with `openssl passwd -6` before being passed to
rpi-image-gen, so there are no complexity restrictions — use whatever
password you want.

The script will:
1. Clone `rpi-image-gen` from GitHub (first run only)
2. Install build dependencies (first run only)
3. Build the image

Output: `CM5/rpi-image-gen/work/image-trailcurrent-cm5-base/trailcurrent-cm5-base.img`

> **Build host requirements:** Debian or Ubuntu (Bookworm/Trixie/Noble).
> On x86_64 hosts, QEMU user-mode emulation is used automatically (slower
> but works). Native arm64 builds are faster.

### 3. Flash the eMMC

#### Put the CM5 in USB Boot Mode

1. If you have an NVMe SSD, install it into the carrier board's M.2 slot
   (optional — it will be set up automatically on first boot)
2. Fit the **EMMC_DISABLE** jumper on the carrier board
3. Connect the carrier board's USB-C to your computer
4. Apply power to the carrier board

#### Expose the eMMC as a USB Device

From the repository root:

```bash
cd CM5/usbboot
sudo ./rpiboot -d mass-storage-gadget64
```

You should see output ending with `Second stage boot server done`. The CM5's
eMMC will appear as a new block device. Check which device it is:

```bash
lsblk
```

Look for a new disk matching the eMMC size (e.g., `/dev/sda`).

> **Be absolutely sure you have the right device.** `dd` will overwrite
> whatever you point it at.

#### Write the Image

Your desktop may auto-mount the eMMC's boot partition. Unmount it before
flashing:

```bash
sudo umount /dev/sdX1 2>/dev/null
sudo umount /dev/sdX2 2>/dev/null
```

Then write the image:

```bash
sudo dd if=CM5/rpi-image-gen/work/image-trailcurrent-cm5-base/trailcurrent-cm5-base.img \
    of=/dev/sdX bs=4M status=progress conv=fsync
```

Replace `/dev/sdX` with your actual device.

#### Prepare for First Boot

1. Remove the EMMC_DISABLE jumper
2. Disconnect the USB cable
3. Connect Ethernet
4. Power cycle the carrier board

### 4. First Boot

On the first boot, the `trailcurrent-firstboot` service runs automatically and
handles all per-device setup:

1. **NVMe setup** — Detects the NVMe drive, creates a GPT partition table,
   formats it as ext4, mounts it at `/mnt/nvme`, and adds an fstab entry.
   Creates symlinks from `~/data` and `~/local_code` to the NVMe.

2. **EEPROM configuration** — Sets `BOOT_ORDER=0xfe1` (eMMC only, then
   stop), `WAKE_ON_GPIO=0`, and `POWER_OFF_ON_HALT=1` so the CM5 boots
   exclusively from eMMC and starts automatically when power is applied
   (no power button needed in a vehicle install).

3. **TLS certificates** — Generates a self-signed CA and server certificate
   for `headwaters.local` (valid 10 years). Used by Mosquitto, Node-RED proxy,
   and the frontend.

4. **Python virtual environment** — Creates the venv at
   `~/local_code/cantomqtt/` and installs the CAN-to-MQTT dependencies.

First boot takes 2-3 minutes. You can monitor progress via:

```bash
ssh trailcurrent@headwaters.local
journalctl -u trailcurrent-firstboot -f
```

After first boot completes, **reboot once** for the EEPROM changes to take
effect:

```bash
sudo reboot
```

### 5. Verify the System

After the reboot:

```bash
# Check NVMe is mounted
df -h /mnt/nvme

# Check Docker is using NVMe storage
docker info | grep "Docker Root Dir"
# Expected: /mnt/nvme/docker

# Check CAN interface (requires CAN hat to be connected)
ifconfig can0

# Check SPI
ls /dev/spidev0.*

# Check all services
systemctl status can0 docker trailcurrent-firstboot
```

### 6. Deploy the Application

The base image is ready for the TrailCurrent application stack. Transfer a
deployment package and run the standard deployment:

```bash
scp trailcurrent-deployment-*.zip trailcurrent@headwaters.local:~/
ssh trailcurrent@headwaters.local
unzip trailcurrent-deployment-*.zip
./deploy.sh
```

See [PI_DEPLOYMENT.md](../PI_DEPLOYMENT.md) for full deployment instructions.

## What's in the Base Image

### System Packages

`jq`, `openssl`, `python3`, `python3-venv`, `python3-pip`, `can-utils`,
`avahi-daemon`, `avahi-utils`, `curl`, `unzip`, `nvme-cli`, `parted`

### Docker

Docker CE and Docker Compose plugin, installed from Docker's official
repository. Data root is on the NVMe at `/mnt/nvme/docker`. Docker waits
for the NVMe mount before starting.

### Boot Configuration (config.txt)

| Setting | Value | Purpose |
|---------|-------|---------|
| `dtparam=spi=on` | enabled | Required for MCP2515 CAN controller |
| `dtoverlay=mcp2515-can0` | 12MHz/GPIO25/2MHz SPI | CAN bus hardware |
| `dtoverlay=disable-bt` | disabled | Power savings |
| `dtoverlay=disable-wifi` | disabled | Power savings (uses Ethernet) |
| `dtoverlay=disable-hdmi0` | disabled | Power savings (headless) |
| `dtoverlay=disable-hdmi1` | disabled | Power savings (headless) |
| `dtparam=audio=off` | disabled | Power savings |
| `gpu_mem=16` | 16 MB | Minimum GPU allocation (headless) |
| `arm_freq=600` | 600 MHz | Underclocked — workload uses ~15% at 1.7 GHz |
| `dtparam=fan_temp0=50000` | 50 C | Lower fan threshold for enclosed operation |

> **Do not add `over_voltage` settings.** CM5 silicon varies between chips —
> undervolting (e.g., `over_voltage=-4`) can prevent some boards from booting
> entirely (3-blink "firmware not found" error) while working fine on others.
> The firmware manages voltage automatically at the configured `arm_freq`.

### Systemd Services

| Service | Purpose | Auto-starts? |
|---------|---------|-------------|
| `trailcurrent-firstboot` | One-time NVMe/EEPROM/TLS/venv setup | Once (first boot only) |
| `can0` | Brings up CAN bus at 500 kbps | Yes (when can0 device exists) |
| `disable-usb` | Unbinds USB hub to save power | Yes |
| `docker` | Container runtime | Yes (after NVMe mount) |
| `cantomqtt` | CAN-to-MQTT bridge | After deployment (ConditionPathExists) |
| `deployment-watcher` | Watches for OTA deployment updates | After deployment (ConditionPathExists) |

## Troubleshooting

### rpiboot doesn't detect the CM5

- Verify the EMMC_DISABLE jumper is fitted
- Check USB connection: `lsusb | grep -i broadcom` should show `BCM2712D0 Boot`
- Try a different USB cable or port
- Power cycle the carrier board with USB already connected
- If `lsusb` shows `Raspberry Pi multi-function USB device` instead of
  `BCM2712D0 Boot`, the CM5 is already in mass storage mode from a previous
  rpiboot session. Power cycle the carrier board (unplug power, wait a few
  seconds, plug back in) and run `rpiboot` again immediately
- **Between consecutive rpiboot operations** (e.g., EEPROM recovery followed by
  flashing), you must power cycle the carrier board. Without a power cycle,
  `rpiboot` will hang at "Waiting for BCM..."

### NVMe not detected on first boot

- Check the drive is seated properly in the M.2 slot
- Verify the drive is recognized: `sudo nvme list`
- Re-run first boot: `sudo rm /var/lib/trailcurrent/.firstboot-done && sudo systemctl start trailcurrent-firstboot`
- Check logs: `journalctl -u trailcurrent-firstboot`

### Docker won't start

- If no NVMe is present, Docker may be waiting for a mount that won't arrive.
  Re-run first boot (which detects the missing NVMe and reconfigures Docker):
  `sudo rm /var/lib/trailcurrent/.firstboot-done && sudo systemctl start trailcurrent-firstboot`

### CAN bus not working

- Verify the CAN hat is connected and the SPI ribbon cable is seated
- Check kernel messages: `dmesg | grep -i mcp2515`
- Check the can0 service: `systemctl status can0`
- The MCP2515 needs ~15 seconds after power-on to stabilize (the service
  handles this with a sleep)

### CM5 won't boot / "Firmware not found" error

If the CM5 won't boot, connect HDMI to **HDMI0** (the primary output) to see
boot diagnostics. Despite the `disable-hdmi` overlays in config.txt, HDMI
output works during boot and at the Linux console.

**Check the boot screen and LEDs for clues:**

| Symptom | Likely cause |
|---------|-------------|
| `FAT 32 bad cluster` in boot output | Corrupted eMMC flash — reflash with `conv=fsync` |
| `Boot mode: STOP` appears immediately | Bad `BOOT_ORDER` in EEPROM — needs EEPROM recovery |
| 3 LED blinks (repeating) | Bootloader can't find firmware — corrupted flash or EEPROM issue |
| Tries NVMe/USB/Network but not eMMC | EEPROM boot order skips eMMC — needs EEPROM recovery |
| Boots an old OS from NVMe | NVMe has a previous install — wipe it or fix boot order |
| Black screen, no LED activity | Check power supply and EMMC_DISABLE jumper is removed |

**If the eMMC flash is corrupted**, reflash using rpiboot (step 3 above). Always
use `conv=fsync` with `dd` to ensure data is fully written before the command
returns. Without `conv=fsync`, `dd` may return before data is physically
written, resulting in a corrupted image.

**If the EEPROM needs recovery**, see the section below.

### EEPROM recovery (BOOT_ORDER or firmware errors)

If the EEPROM boot order is misconfigured and the CM5 won't boot at all, you
can reflash the EEPROM directly using the usbboot recovery tool:

1. Fit the **EMMC_DISABLE** jumper
2. Connect USB-C to your computer
3. Power on the carrier board
4. Run the EEPROM recovery:

```bash
cd CM5/usbboot/recovery5
./update-pieeprom.sh
sudo ../rpiboot -d .
```

This resets the EEPROM to factory defaults (`BOOT_ORDER=0xf2461`). Wait for
the tool to complete, then:

5. Power cycle the carrier board (unplug power, wait a few seconds, replug) —
   `rpiboot` will not work for subsequent operations without a power cycle
6. Remove the EMMC_DISABLE jumper
7. Power cycle the board again to boot normally

The CM5 should now boot from eMMC. The first-boot script will reconfigure the
EEPROM with the production settings (`BOOT_ORDER=0xfe1`) on its next run.

> **Note:** If `update-pieeprom.sh` reports missing files, ensure the usbboot
> submodule is initialized: `cd CM5/usbboot && git submodule init && git submodule update`

### Checking first-boot logs

```bash
journalctl -u trailcurrent-firstboot --no-pager
```

## File Layout Reference

```
CM5/
├── SETUP.md                  <- This file
├── usbboot/                  <- rpiboot tool (built from source)
│   └── rpiboot              <- Binary for USB boot mode
├── image/                    <- Image build system
│   ├── build.sh             <- Build wrapper script
│   ├── config/
│   │   └── trailcurrent-cm5-base.yaml   <- Build configuration
│   └── layer/
│       ├── trailcurrent-base.yaml       <- Custom layer (packages, services, config)
│       └── files/
│           └── trailcurrent-firstboot.sh <- First-boot setup script
└── rpi-image-gen/            <- Cloned automatically by build.sh (not committed)
```
