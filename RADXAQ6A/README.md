# TrailCurrent Headwaters — Radxa Dragon Q6A Image

Build a flashable Radxa Dragon Q6A image that runs the full Headwaters
in-vehicle compute stack (Docker + Compose, MQTT broker, MongoDB, tileserver,
backend, frontend, CAN-to-MQTT bridge) with the NPU, WiFi/BT, display,
camera, and audio subsystems disabled at boot for low idle power draw.

The Q6A target is an alternate hardware platform alongside the CM5. The
CM5 build lives in [CM5/](../CM5/) and is unchanged — this directory is
fully self-contained and shares no scripts with the CM5 pipeline.

## TL;DR

```bash
# 0. From repo root: build ARM64 Docker images and ensure map tiles exist
./build-and-save-images.sh
ls data/tileserver/map.mbtiles   # required

# 1. One-time build host setup
sudo apt install -y jsonnet bdebstrap libguestfs-tools \
    qemu-user-static binfmt-support device-tree-compiler \
    gdisk parted git curl gpg rsync unzip
./RADXAQ6A/image/preflight.sh

# 2. Build the image (~30-60 min)
sudo ./RADXAQ6A/image/build.sh

# 3. Flash SPI NOR firmware (one-time per board) and OS
#    Put board in EDL mode first: hold EDL button while powering on
sudo ./RADXAQ6A/image/flash.sh --firmware
sudo ./RADXAQ6A/image/flash.sh --os RADXAQ6A/image/output/headwaters-q6a-v0.0.28.img

# 4. Connect Ethernet + 12V power. The HAT can stay installed.
#    Wait ~3 minutes for first-boot setup to finish.

# 5. SSH in
ssh trailcurrent@headwaters.local     # password: trailcurrent
# The first-login wizard prompts for MQTT / admin passwords, then starts Docker.
```

## Boot is fully unattended (how we got there)

This image ships a **patched embloader.efi** that autoboots the default
loader entry without polling UEFI ConIn when `timeout 0` is set in
`/boot/efi/loader/loader.conf`. That matters because of the underlying
hardware quirk:

The Q6A's debug UART (`qcom_geni @ 0x994000` → `ttyMSM0`) is muxed to
40-pin header pins 8 (TX) and 10 (RX) — `gpio22` / `gpio23` in the SoC
pinout. RX has no on-board bias resistor, so once any HAT is installed
on the header, EMI from adjacent high-frequency SPI clocks (e.g., the
MCP2515 SPI bus running on `gpio48`-`gpio51`) capacitively couples
enough noise into the floating RX line for the SoC's UART block to
decode phantom serial bytes. Stock Radxa embloader 0.4 reads ConIn
during the autoboot wait window even at `timeout 0`, sees those phantom
bytes as keystrokes, and traps the user at the boot menu requiring
keyboard intervention every boot.

We attempted lighter-weight fixes first and proved them ineffective:

- **Setting `BootAskValid` and `ConIn` UEFI variables from Linux** — the
  SPI NOR firmware re-seeds both on every boot from internal config.
  Empirically verified by writing zeros and rebooting; values reverted.
- **Hardware pull-up on header pin 10** — would work but the project
  excludes hardware modification.
- **Disabling the kernel-side console on `ttyMSM0`** — irrelevant, the
  trap is in firmware before the kernel runs.

The only durable software path identified by reading
[`embloader/src/menu/menus/text_menu.c`](https://github.com/BigfootACA/embloader/blob/0.4/embloader/src/menu/menus/text_menu.c)
is a small patch that short-circuits the menu when `timeout == 0`. The
patch lives at `RADXAQ6A/image/embloader/patches/0001-headwaters-
autoboot-on-timeout-zero.patch` and is applied to upstream tag `0.4`
(commit `9f8e74b` — exactly what Radxa ships) by
`RADXAQ6A/image/embloader/build-embloader.sh` during image build. The
resulting `embloader.efi` is installed to `/EFI/BOOT/BOOTAA64.EFI` and
`/EFI/systemd/systemd-bootaa64.efi` on the ESP by rsdk hook 19d. Hook
22 verifies the sha256 matches the build-side artifact.

### Build-host prerequisites for the embloader build

In addition to the standard image-build deps (jsonnet, bdebstrap,
guestfish, etc.) the embloader build needs:

```bash
sudo apt install -y nasm acpica-tools uuid-dev pkg-config gcc-aarch64-linux-gnu
```

`./RADXAQ6A/image/preflight.sh` checks for all of these. The first
embloader build clones EDK2 (~5 min) and produces a ~1.5 MB
`embloader.efi`. Subsequent builds are cached under `RADXAQ6A/image/
cache/embloader-build/` keyed on the patch SHA + upstream commit — only
rebuilds if you change the patch or bump the pinned commit.

## First-boot service architecture

The work that runs once on a freshly flashed board is split across two
units. The split is load-bearing: `pip install` requires the network,
which isn't available before `sysinit.target`, but rootfs resize and
SSH host-key generation must run that early. Mixing them in one unit
guarantees one of the two breaks every time.

| Unit | Ordering | Responsibilities | Sentinel |
|------|---------|------------------|----------|
| `headwaters-firstboot.service` | `Before=sysinit.target` | Resize root partition, regenerate `machine-id`, regenerate SSH host keys, the SSH-socket dance, create Docker bind-mount targets, generate per-device TLS/SSL certificates | `/var/lib/headwaters/.firstboot-done` |
| `headwaters-firstboot-network.service` | `After=network-online.target` | Create the Python venv, `pip install -r requirements.txt` (with DNS-wait + 5× retry + import-verify), restart the Python services so they pick up the populated venv | `/var/lib/headwaters/.firstboot-network-done` |

Both units check `ConditionPathExists=!<sentinel>` so they only run
once, and both refuse to write their sentinel unless every step
succeeded — a partial failure leaves the sentinel absent and the unit
re-runs on the next boot. Empirically, the network-stage retry budget
handles transient DNS hiccups and PyPI outages without operator
intervention.

## CAN bus reliability (race-free bring-up)

`can0.service` invokes `headwaters-can0-up.sh` instead of using
`ConditionPathExists=/sys/class/net/can0`. The condition fires too
early on cold boot — before the MCP2515 SPI driver finishes binding —
and silently skips the service. The script polls for the netdev with a
30 s deadline, configures it at 500 kbit/s when it appears, and exits
cleanly if it never does. No boot stall when the HAT is absent
(bench/dev), no race when it's present (production).

## Why Q6A?

| | CM5 (Pi) | Dragon Q6A |
|---|---|---|
| SoC | BCM2712 (4× A76 @ 2.4 GHz) | QCS6490 (4× A78 @ 2.7 GHz + 4× A55 @ 1.9 GHz) |
| RAM | 4 / 8 / 16 GB | **4** / 8 / 16 GB (we target the 4 GB SKU) |
| NPU | none | Hexagon DSP (unused here — disabled) |
| Storage | eMMC on the SoM, NVMe via the *carrier board* | NVMe on-board — **no NVMe-capable carrier required** |
| Built-in cellular | no | yes (via module slot) |
| Target power | low (~3 W idle) | low (underclocked + subsystems off, target ≤5 W idle) |

**Price is the main reason to offer a Q6A image.** Three cost levers combine
to land the Q6A BOM at or below the equivalent Pi-based Headwaters BOM:

1. **4 GB Dragon Q6A with on-board NVMe** vs. 4 GB CM5 + NVMe-capable carrier
   + separate M.2 drive — three parts collapse into one module.
2. **Plain Waveshare RS485 CAN HAT** is noticeably cheaper than the
   Waveshare RS485 CAN HAT (B) used on the CM5 target.
3. **On-board 12 V input** on the Q6A — no 12→5 V buck regulator or USB-C PD
   path required, shaving another component off the power stage.

Its NPU and higher clock speeds aren't needed for the Headwaters workload
(MongoDB + Mosquitto + Node backend + nginx + tileserver) and are explicitly
disabled in this image so idle power stays close to the CM5's.

### Why keep both CM5 and Q6A targets?

Cost alone would argue for consolidating on the Q6A, but the CM5 build
stays fully supported for **hardware sourcing resilience**. Supporting two
independent SoC vendors (Broadcom and Qualcomm) across two independent
board vendors (Raspberry Pi Ltd. and Radxa) means a Headwaters build can
ship even if one SKU is EOL'd, allocated out, or hit by a price spike.
Both images build from the same `build-and-save-images.sh` Docker artifacts
and same map tiles, so the only per-platform work is a one-time image-build
difference and per-SKU quality gating.

## What's disabled for power savings

| Subsystem | How |
|---|---|
| NPU (Hexagon DSP / FastRPC) | No userspace pkgs, kernel modules blacklisted (`disable-unused.conf`), cDSP/aDSP remoteproc stopped at boot (`power-save-hw.service`) |
| WiFi | `rfkill` + `cfg80211`/`mac80211`/`ath*` blacklist |
| Bluetooth | `rfkill` + `bluetooth`/`btusb`/`hci_uart` blacklist, `bluetooth.service` masked |
| Display (DPU/DSI/DP) | `msm`/`msm_dsi`/`msm_dp`/`msm_mdss` blacklist + platform driver unbind |
| Camera (CAMSS) | `camss` blacklist + platform driver unbind |
| Audio (Q6 / audioreach) | Audio driver blacklist, PulseAudio/PipeWire autospawn off |
| GPU | `powersave` devfreq governor, frequency pinned at minimum |
| CPU | `powersave` governor, `scaling_max_freq` capped at 600 MHz on **all 8 cores** (matches CM5's `arm_freq=600`). Big cores stay online so bursty workloads keep CM5-parity or better. |
| USB | `usbcore.autosuspend=-1` + per-device `power/control=auto` for non-HID/non-hub devices |

Everything above is undone by deleting the relevant file in
[`image/files/`](image/files/) and rebuilding — no code changes.

## Project layout

```
RADXAQ6A/
├── README.md                    You are here
├── SETUP.md                     Operator guide (flash + first boot)
└── image/
    ├── build.sh                 Top-level build orchestrator
    ├── preflight.sh             Build host verification
    ├── flash.sh                 edl-ng wrapper (SPI NOR + NVMe)
    ├── rsdk/                    Vendored Radxa SDK + Headwaters rootfs.jsonnet
    ├── firmware/                SPI NOR firmware (committed, binary)
    ├── overlays/                Device-tree overlay sources (.dts) — compiled
    │                            on build host by build.sh, no DKMS needed
    ├── files/                   Files baked into the image
    │   ├── systemd/             headwaters-firstboot, cpu-powersave,
    │   │                        power-save-hw, can0, cantomqtt, etc.
    │   ├── scripts/             headwaters-firstboot.sh, -first-login.sh,
    │   │                        -load-images.sh
    │   ├── modprobe/            disable-unused.conf (NPU/WiFi/BT/display/camera/audio)
    │   ├── plymouth/            Boot splash theme
    │   ├── motd/                SSH MOTD ASCII art + /etc/issue
    │   ├── profile/             Branded shell prompt + first-login hook
    │   ├── sysctl/              90-headwaters.conf
    │   └── ssh/                 sshd_config.d/10-trailcurrent.conf
    ├── cache/                   (gitignored)
    └── output/                  Built images (gitignored, ~28 GB each)
```

## CAN bus (Waveshare RS485 CAN HAT)

The Waveshare RS485 CAN HAT plugs directly onto the Q6A's 40-pin header.
Although the Q6A's header layout is electrically RPi-HAT-compatible, the
GPIO numbering is the QCS6490 tlmm scheme (not the RPi BCM scheme), so a
Q6A-specific device-tree overlay is required — not the RPi one.

Pin map on the Q6A's 40-pin header for the HAT:

| HAT pin | RPi label | Q6A GPIO | Q6A function |
|---|---|---|---|
| 19 | MOSI | `GPIO_49` | `SPI12_MOSI` |
| 21 | MISO | `GPIO_48` | `SPI12_MISO` |
| 23 | SCLK | `GPIO_50` | `SPI12_SCLK` |
| 24 | CE0  | `GPIO_51` | `SPI12_CS_0` |
| 22 | INT (GPIO25 on RPi) | **`GPIO_57`** | MCP2515 interrupt |

The overlay source is **vendored in this repo** at
[`image/overlays/qcs6490-radxa-dragon-q6a-spi12-cs0-mcp2515-12mhz.dts`](image/overlays/qcs6490-radxa-dragon-q6a-spi12-cs0-mcp2515-12mhz.dts)
— a 60-line DTS derived from Radxa's upstream DTSO with the two `#include`
directives and the `IRQ_TYPE_EDGE_FALLING` macro inlined as a literal so
the file compiles with plain `dtc -@`, no cpp preprocessing, no kernel
headers, no DKMS.

`build.sh` compiles the overlay on the build host during staging (preflight
catches a missing `dtc` up front), then hook 19b installs the pre-compiled
`.dtbo` into the image following the same loader-entry layout `rsetup` uses:

1. Copy the `.dtbo` into `/boot/efi/<entry-token>/<kernel-ver>/dtbo/`
2. Copy the base `qcs6490-radxa-dragon-q6a.dtb` into `/boot/efi/<entry-token>/<kernel-ver>/`
3. Append `devicetree /<token>/<kver>/*.dtb` and
   `devicetree-overlay /<token>/<kver>/dtbo/*.dtbo` lines to the systemd-boot
   loader entry at `/boot/efi/loader/entries/<token>-<kver>.conf`

At boot, systemd-boot (v252+) merges the overlay into the fdt before passing
it to the kernel. `mcp251x` probes on `&spi12` CS0 with `GPIO_57` as its
falling-edge interrupt, the `can0` netdev appears, and `can0.service` brings
it up at 500 kbit/s.

**Verify on a running board:**
```bash
ip -d link show can0            # should show "mcp251x" bound at 500000
grep devicetree /boot/efi/loader/entries/*.conf
```

The bitrate (currently 500 kbit/s) is set in
[`image/files/systemd/can0.service`](image/files/systemd/can0.service).
Change it there and rebuild to re-provision at a different rate, or override
the running setting with `ip link set can0 type can bitrate <N>`.

## Cleanup between builds

Same rules as the Peregrine Q6A image — see
[`../../TrailCurrentPeregrine/image_build/README.md`](../../TrailCurrentPeregrine/image_build/README.md#cleanup-between-builds)
(Scenarios 1–4). The only renames:
- `/tmp/peregrine-staging` → `/tmp/headwaters-staging`
- `image_build/` → `image/`

## Default credentials

| Setting | Value |
|---|---|
| Username | `trailcurrent` |
| Password | `trailcurrent` (retained until first-login wizard writes `.env`) |
| Hostname | `headwaters` |
| mDNS | `headwaters.local` |
| Root login | Disabled |
| Web UI | `https://headwaters.local/` (after wizard runs) |
