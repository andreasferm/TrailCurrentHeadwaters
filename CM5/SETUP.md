# CM5 Setup Guide

This guide covers everything needed to go from bare Compute Module 5 boards to
running TrailCurrent Headwaters units. It is designed for mass flashing — follow
the steps in order with no gaps.

## Hardware Requirements

- Raspberry Pi Compute Module 5 (CM5 or CM5 Lite — eMMC is not used)
- CM5 carrier board (IO Board or custom) with:
  - USB-C port for flashing
  - EMMC_DISABLE jumper (sometimes labelled "nRPIBOOT" or "Disable eMMC Boot")
    — only needed for CM5 with eMMC; CM5 Lite enters USB boot automatically
  - NVMe M.2 slot (M-key or B+M-key)
- NVMe SSD (128 GB+ recommended) — this is the boot and root drive
- Waveshare RS485 CAN HAT (B) (MCP2515, SPI0/CE0, 16 MHz crystal, GPIO25 interrupt)
- Ethernet connection
- A Linux computer for building and flashing (Debian/Ubuntu, arm64 or x86_64)

## Storage Architecture

Everything lives on the NVMe drive. The root partition is automatically
expanded to fill the entire drive on first boot.

| Drive | Mount | Contents |
|-------|-------|----------|
| NVMe  | `/`   | OS, system packages, Docker (engine + images + volumes), app data, Python venv |

Application data directories:

```
~/data           (keys, tileserver, node-red)
~/local_code     (Python venv, CAN-to-MQTT scripts)
```

Docker uses the default data-root (`/var/lib/docker`) since everything is on
the NVMe.

> **CM5 with eMMC:** The eMMC is present but unused. The EEPROM is configured
> to boot exclusively from NVMe (`BOOT_ORDER=0xfe6`).

## One-Time Setup (Build Host)

These steps only need to be done once on the computer you use for flashing.

### 1. Build the rpiboot Tool

The `rpiboot` tool loads a payload onto the CM5 over USB. The `-d` flag
selects which payload directory to use — different directories do different
things:

| Command | Payload | What it does |
|---------|---------|-------------|
| `rpiboot -d recovery5` | EEPROM updater | Programs the CM5's EEPROM (boot order, power settings). No storage is exposed. |
| `rpiboot -d mass-storage-gadget64` | Minimal Linux | Boots Linux on the CM5 which exposes its storage (eMMC, NVMe) as USB mass storage devices for flashing. |

The `rpiboot` binary is the same in both cases. **You must power cycle the
carrier board between consecutive rpiboot operations.**

The version from APT has known issues with CM5, so we build from source:

```bash
git clone https://github.com/raspberrypi/usbboot CM5/usbboot
cd CM5/usbboot
git submodule init && git submodule update
make
```

This produces the `rpiboot` binary in `CM5/usbboot/`. The submodule step
fetches the EEPROM firmware files needed for both flashing and EEPROM
configuration.

### 2. Build the EEPROM Image

The EEPROM must be configured to boot from NVMe before a board will work.
Build the EEPROM image once — it is reused for every board:

```bash
cd CM5/usbboot/recovery5
./update-pieeprom.sh
```

This bakes `boot.conf` (which sets `BOOT_ORDER=0xf16` — NVMe first, SD
fallback) into an EEPROM image. The output is used in the per-device
procedure below.

### 3. Build the Base Image

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

---

## Per-Device Flashing Procedure

Repeat these steps for each CM5 board. The order matters — do not skip steps.

### Step 1: Prepare the Hardware

1. Install the NVMe SSD into the carrier board's M.2 slot
2. **CM5 with eMMC:** Fit the **EMMC_DISABLE** jumper on the carrier board
   **CM5 Lite:** No jumper needed — skip this step
3. Connect the carrier board's USB-C to your computer
4. Apply power to the carrier board
5. Verify the CM5 is detected:
   ```bash
   lsusb | grep -i broadcom
   ```
   You should see `BCM2712D0 Boot`.

### Step 2: Flash the EEPROM (Required for Every New Board)

Fresh CM5 boards ship with a factory boot order (`BOOT_ORDER=0xf2461`) that
tries eMMC/SD before NVMe. **The board will not boot from NVMe until the
EEPROM is updated.** This step must be done before flashing the NVMe image.

```bash
cd CM5/usbboot/recovery5
sudo ../rpiboot -d .
```

Wait for the tool to complete (you'll see `Second stage boot server done`
followed by EEPROM write messages).

**Power cycle the carrier board** — unplug power, wait a few seconds, plug
back in. rpiboot will not work for the next step without a power cycle.

### Step 3: Wipe Old Storage (Recommended)

This step ensures no leftover partitions or boot data cause issues. Skip this
only if you are certain the board has never been flashed before.

Put the CM5 back into USB mass storage mode:

```bash
cd CM5/usbboot
sudo ./rpiboot -d mass-storage-gadget64
```

Wait for `Second stage boot server done`, then check what appeared:

```bash
lsblk
```

- **CM5 Lite:** One new `sd*` device appears — that's the NVMe.
- **CM5 with eMMC:** Two new `sd*` devices appear. The NVMe is the **larger**
  one (e.g., 128+ GB vs 16/32 GB for eMMC).

Unmount any auto-mounted partitions, then zero both devices (or just the NVMe
if CM5 Lite):

```bash
# Unmount anything that auto-mounted
sudo umount /dev/sdX* 2>/dev/null

# Wipe the NVMe (replace sdX with the larger device)
sudo dd if=/dev/zero of=/dev/sdX bs=4M count=100 status=progress conv=fsync

# Wipe the eMMC too if present (replace sdY with the smaller device)
sudo dd if=/dev/zero of=/dev/sdY bs=4M count=100 status=progress conv=fsync
```

This zeros the first 400 MB, which destroys partition tables, boot sectors,
and filesystem headers.

**Power cycle the carrier board** before the next step. **Be sure to hold the boot button again when plugging in**

### Step 4: Flash the NVMe

Put the CM5 back into USB mass storage mode:

```bash
cd CM5/usbboot
sudo ./rpiboot -d mass-storage-gadget64
```

Wait for `Second stage boot server done`, then identify the NVMe:

```bash
lsblk
```

- **CM5 Lite:** One new `sd*` device (no partitions) — that's the NVMe.
- **CM5 with eMMC:** Two `sd*` devices with no partitions. The NVMe is the
  **larger** one.

> **Be absolutely sure you have the right device.** `dd` will overwrite
> whatever you point it at. Your host's NVMe drives show up as `nvme*`, not
> `sd*`, so there is no risk of confusion with local drives.

Unmount any auto-mounted partitions, then write the image:

```bash
sudo umount /dev/sdX* 2>/dev/null
#cd to root of project
sudo dd if=CM5/rpi-image-gen/work/image-trailcurrent-cm5-base/trailcurrent-cm5-base.img \
    of=/dev/sdX bs=4M status=progress conv=fsync
```

Replace `/dev/sdX` with the NVMe device.

> **Always use `conv=fsync`.** Without it, `dd` may return before data is
> physically written, resulting in a corrupted image.

### Step 5: Prepare for First Boot

1. **CM5 with eMMC:** Remove the EMMC_DISABLE jumper
2. Disconnect the USB cable
3. Connect Ethernet
4. Power cycle the carrier board

### Step 6: First Boot

The CM5 should boot from NVMe. On the first boot, the
`trailcurrent-firstboot` service runs automatically and handles all
per-device setup:

1. **Partition expansion** — Expands the root partition to fill the entire
   NVMe drive using `growpart` and `resize2fs`.

2. **EEPROM configuration** — Sets `BOOT_ORDER=0xfe6` (NVMe only, then
   stop), `WAKE_ON_GPIO=0`, and `POWER_OFF_ON_HALT=1` so the CM5 boots
   exclusively from NVMe and starts automatically when power is applied
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

### Step 7: Verify the System

After the reboot:

```bash
# Check root is on NVMe and partition is expanded
df -h /

# Check Docker is running
docker info | grep "Docker Root Dir"
# Expected: /var/lib/docker

# Check CAN interface (requires CAN hat to be connected)
ifconfig can0

# Check SPI
ls /dev/spidev0.*

# Check all services
systemctl status can0 docker trailcurrent-firstboot
```

### Step 8: Transfer Map Tiles

The tileserver requires a map tiles file (~25 GB). This must be transferred
before deploying the application, as the tileserver container will fail
without it.

From your build host:

```bash
scp /path/to/map.mbtiles trailcurrent@headwaters.local:~/data/tileserver/
```

> **This transfer takes a while over Ethernet.** You can continue with
> Steps 9-10 in a separate SSH session while the transfer runs, but do not
> start the application (Step 11) until the transfer is complete.

### Step 9: Transfer the Deployment Package

From your build host:

```bash
scp trailcurrent-deployment-*.zip trailcurrent@headwaters.local:~/
```

### Step 10: Configure the Environment

SSH to the board and extract the deployment package:

```bash
ssh trailcurrent@headwaters.local
unzip trailcurrent-deployment-*.zip
```

The first run of `deploy.sh` creates `.env` from `.env.example`. Edit it
with your credentials:

```bash
cp .env.example .env
nano .env
```

Set these values:
- `MQTT_USERNAME` / `MQTT_PASSWORD` — MQTT broker credentials
- `ADMIN_PASSWORD` — Admin password for the web UI
- `TLS_CERT_HOSTNAME=headwaters.local`
- `ENCRYPTION_KEY` — generate with `openssl rand -hex 32`
- `NODE_RED_CREDENTIAL_SECRET` — generate with `openssl rand -hex 64`

### Step 11: Deploy the Application

```bash
chmod +x deploy.sh
./deploy.sh
```

`deploy.sh` will:
- Load all Docker images from tar files
- Start all services
- Set up the CAN-to-MQTT bridge
- Set up the deployment watcher (for cloud OTA updates)
- Deploy MCU firmware via OTA (if firmware is included)

### Step 12: Verify the Application

```bash
# All containers running
docker compose ps

# No errors in logs
docker compose logs --tail=20

# API responding
curl -k https://localhost/api/health

# Web UI accessible
curl -k -o /dev/null -s -w "%{http_code}" https://localhost/
```

Access the web UI at `https://headwaters.local`.

See [PI_DEPLOYMENT.md](../PI_DEPLOYMENT.md) for update procedures, CA
certificate installation on client devices, and troubleshooting.

---

## Per-Device Quick Reference

For experienced operators who have done this before. Refer to the full
procedure above if anything is unclear.

```
For each board:
  1. Install NVMe, fit EMMC_DISABLE jumper (if eMMC), connect USB, power on
  2. cd CM5/usbboot/recovery5 && sudo ../rpiboot -d .       # Flash EEPROM
  3. Power cycle
  4. cd CM5/usbboot && sudo ./rpiboot -d mass-storage-gadget64  # Expose storage
  5. lsblk                                                   # Identify NVMe (larger sd* device)
  6. sudo dd if=...img of=/dev/sdX bs=4M status=progress conv=fsync  # Flash NVMe
  7. Remove jumper, disconnect USB, connect Ethernet, power cycle
  8. Wait for first boot (~2-3 min), then: sudo reboot
  9. Verify base: df -h / && systemctl status can0
 10. scp map.mbtiles to ~/data/tileserver/
 11. scp deployment zip, unzip, configure .env
 12. ./deploy.sh
 13. Verify: docker compose ps && curl -k https://localhost/api/health
```

---

## What's in the Base Image

### System Packages

`jq`, `openssl`, `python3`, `python3-venv`, `python3-pip`, `iproute2`,
`can-utils`, `avahi-daemon`, `avahi-utils`, `curl`, `unzip`, `nvme-cli`,
`parted`, `cloud-guest-utils`

### Docker

Docker CE and Docker Compose plugin, installed from Docker's official
repository. Uses the default data root (`/var/lib/docker`) on the NVMe root
filesystem.

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
| `trailcurrent-firstboot` | One-time partition expansion/EEPROM/TLS/venv setup | Once (first boot only) |
| `can0` | Brings up CAN bus at 500 kbps | Yes (when can0 device exists) |
| `disable-usb` | Unbinds USB hub to save power | Yes |
| `docker` | Container runtime | Yes |
| `cantomqtt` | CAN-to-MQTT bridge | After deployment (ConditionPathExists) |
| `deployment-watcher` | Watches for OTA deployment updates | After deployment (ConditionPathExists) |

## Troubleshooting

### rpiboot doesn't detect the CM5

- **CM5 with eMMC:** Verify the EMMC_DISABLE jumper is fitted
- **CM5 Lite:** Should enter USB boot automatically — if not, check power
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

### NVMe not detected by rpiboot

- Check the NVMe SSD is seated properly in the M.2 slot
- After running `rpiboot -d mass-storage-gadget64`, run `lsblk` to confirm
  the NVMe appears as a block device
- Try a different NVMe drive

### Docker won't start

- Check Docker service status: `systemctl status docker`
- Check logs: `journalctl -u docker`

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
| `Boot mode: STOP` appears immediately | Bad `BOOT_ORDER` in EEPROM — redo Step 2 |
| 3 LED blinks (repeating) | Bootloader can't find firmware — corrupted flash or EEPROM issue |
| Tries eMMC/SD/USB but not NVMe | EEPROM boot order doesn't include NVMe — redo Step 2 |
| Black screen, no LED activity | Check power supply and EMMC_DISABLE jumper is removed (CM5 with eMMC) |
| `no image found` | NVMe is blank or not flashed — do Step 4 |

**If the NVMe flash is corrupted**, reflash using Steps 3-4 of the per-device
procedure. Always use `conv=fsync` with `dd` to ensure data is fully written
before the command returns.

### EEPROM recovery

If the EEPROM is in an unknown state, redo Step 2 of the per-device procedure:

1. Fit the **EMMC_DISABLE** jumper (CM5 with eMMC) or just connect USB (CM5 Lite)
2. Connect USB-C to your computer
3. Power on the carrier board
4. Run:
   ```bash
   cd CM5/usbboot/recovery5
   sudo ../rpiboot -d .
   ```
5. Power cycle, then continue with Step 3 or Step 4

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
│   ├── rpiboot              <- Binary for USB boot mode
│   └── recovery5/           <- EEPROM configuration
│       ├── boot.conf        <- Boot order settings (BOOT_ORDER=0xf16)
│       └── update-pieeprom.sh <- Builds EEPROM image from boot.conf
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
