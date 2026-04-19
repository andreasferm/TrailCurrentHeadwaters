# TrailCurrent Headwaters — Q6A Operator Setup Guide

Flashing a Radxa Dragon Q6A with a freshly built Headwaters image. This
is the Q6A equivalent of [`../CM5/SETUP.md`](../CM5/SETUP.md).

## 0. What you need

- A Radxa Dragon Q6A board — the 4 GB SKU is the default target and
  has on-board NVMe, so no separate M.2 drive or NVMe-capable carrier
  is required
- USB-C cable, laptop running Linux
- 12 V DC power supply for the Q6A
- Ethernet cable (WiFi is disabled by default)
- The built image at `RADXAQ6A/image/output/headwaters-q6a-vX.Y.Z.img`

If you don't have the image yet, see [`README.md`](README.md) for the
build procedure.

## 1. Enter EDL (Emergency Download) mode

The Q6A boots from its on-board SPI NOR flash, which must contain the
EDK2 UEFI bootloader. When EDL mode is active, the board enumerates
as a USB device in **Emergency Download** mode and accepts raw writes
to SPI NOR and NVMe via the Firehose protocol.

1. Disconnect 12 V power from the Q6A
2. Plug the USB-C cable from the Q6A into your laptop
3. Hold the **EDL** button on the board
4. While holding EDL, apply 12 V power
5. Release EDL after ~2 seconds
6. Verify detection on your laptop:
   ```bash
   lsusb | grep 9008
   # Expect: Bus 00X Device 00Y: ID 05c6:9008 Qualcomm, Inc. ...
   ```

If `05c6:9008` does not appear, try the EDL entry again (timing matters).

## 2. Flash SPI NOR firmware (first time only)

Only required the **first time** a board is flashed, or when upgrading
the bootloader. If the board has been flashed before and you're just
replacing the OS, skip to step 3.

```bash
cd /path/to/TrailCurrentHeadwaters
sudo ./RADXAQ6A/image/flash.sh --firmware
```

The script prompts before writing; type `y` to continue. Takes ~1 minute.

## 3. Flash the OS image to NVMe

```bash
sudo ./RADXAQ6A/image/flash.sh --os RADXAQ6A/image/output/headwaters-q6a-vX.Y.Z.img
```

Takes ~10–20 minutes depending on image size (map tiles dominate).
The image includes:
- Ubuntu Noble 24.04 minimal (CLI, no desktop)
- Docker CE + Compose
- All Headwaters Docker images (backend, frontend, mongodb, mosquitto, tileserver)
- Map tiles (`map.mbtiles`)
- Host-side Python scripts (CAN-to-MQTT, discovery-mdns, deployment-watcher)
- Branded boot splash + MOTD

## 4. First boot

1. **Disconnect the USB-C cable** from the Q6A
2. Connect Ethernet to the Q6A
3. Apply 12 V power
4. Wait ~3 minutes — first boot runs `headwaters-firstboot.service` which:
   - Regenerates `machine-id` and SSH host keys
   - Expands the root partition to fill the NVMe
   - Generates TLS/SSL certificates for `headwaters.local`
   - Creates the Python venv and installs CAN-to-MQTT dependencies
   - Loads the baked-in Docker image tarballs (`headwaters-load-images.service`)

Monitor progress (optional) with a serial console if you have one wired
up, or just wait and try to SSH.

## 5. First login (setup wizard)

```bash
ssh trailcurrent@headwaters.local
# Password: trailcurrent
```

On the first interactive session, the wizard runs and asks for:
- MQTT username (default `trailcurrent`)
- MQTT password
- System admin password (for the web UI)

It then:
1. Generates the `ENCRYPTION_KEY` (32-byte hex)
2. Writes `~/.env` and `~/local_code/.env`
3. Installs the TrailCurrent CA certificate to the system trust store
4. Runs `docker compose up -d` to start the application stack
5. Restarts the host-side systemd services (cantomqtt, discovery-mdns,
   deployment-watcher)
6. Prints the CA certificate PEM for you to install in your browser

The wizard writes `~/.headwaters-setup-complete` when done so it never
re-runs on subsequent logins.

## 6. Access the web UI

```
https://headwaters.local/
```

You'll see a certificate warning the first time unless you installed
the CA certificate the wizard printed. Follow the instructions on-screen
to trust it (Chrome/Firefox/macOS/Windows all have one-click options).

## 7. Verify everything is running

```bash
docker compose ps       # 5 containers should be "Up"
systemctl status cantomqtt discovery-mdns deployment-watcher --no-pager
sudo journalctl -u headwaters-firstboot -b   # first-boot log
```

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| No `headwaters.local` on the network | firstboot never completed | SSH by IP and `journalctl -b -u headwaters-firstboot` |
| SSH refused | firstboot still running | wait 3 min; first-boot regens host keys |
| `docker compose ps` empty | images not loaded | `systemctl status headwaters-load-images` |
| Tileserver container restarting | `map.mbtiles` missing in image | rebuild with `data/tileserver/map.mbtiles` present |
| `can0` not appearing | MCP2515 overlay didn't merge at boot | `grep devicetree /boot/efi/loader/entries/*.conf` — both `devicetree` and `devicetree-overlay` lines must exist. Check `dmesg \| grep -iE 'mcp251x\|spi12'` for probe errors (wrong CS, missing HAT, 12 MHz instead of 8 MHz crystal variant). |
| `cantomqtt.service` inactive | `can0` absent (see row above), or `local_code/can-to-mqtt.py` wasn't staged | `ls /home/trailcurrent/local_code/` to confirm Python code is present |

For anything else, attach the output of the commands in step 7.
