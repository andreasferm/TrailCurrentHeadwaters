# Controlling a Playbill from a CAN MCU

This is the wire-level contract for any third-party CAN device — a steering-wheel
button MCU, an IR-receiver, a future hard-buttons remote panel — that wants to
control a Playbill (or any future Linux head-unit endpoint) directly on the CAN
bus, without going through MQTT, the PWA, or any Headwaters service.

> **Source of truth:** the live DBC at
> [`TrailCurrentDocumentation/TrailCurrent.dbc`](../../TrailCurrentDocumentation/TrailCurrent.dbc),
> with narrative explanations in Playbill's
> [`docs/app/dbc-additions.md`](../../TrailCurrentPlaybill/docs/app/dbc-additions.md).
> Anything in this doc that disagrees with the DBC is wrong — defer to the DBC.

---

## 1 · Multi-instance addressing

A rig can host up to three Playbill instances (living room, bedroom, bunkhouse,
…). Each Playbill claims one of three CAN address blocks at install time via its
`device.canInstance` setting:

| `canInstance` | Block         | What it controls |
|---|---|---|
| `0` | `0x100 – 0x10F` | Playbill 0 |
| `1` | `0x110 – 0x11F` | Playbill 1 |
| `2` | `0x120 – 0x12F` | Playbill 2 |
| `null` | (none) | MQTT-only — does not participate in CAN |

Every message type uses the **same offset within the block**, so the address
math is `base + offset`:

```
target_id = (0x100 + 0x10 * instance) + offset
```

If you're building a remote that only ever talks to "the" Playbill on a rig that
only has one, hard-code `instance = 0` and pretend the rest don't exist. If you
want to support multi-instance rigs, expose `instance` as a configuration field
on your MCU and let the user pick.

---

## 2 · Message reference

All payloads are byte-aligned, Motorola big-endian (per the DBC). 8-byte
TWAI/CAN 2.0A frames; messages shorter than 8 bytes leave trailing bytes
unused (don't transmit garbage there).

### PlaybillNavCmd — D-pad / remote keys

| Offset | Direction | Size |
|---|---|---|
| `+0x0` | → Playbill | 1 byte |

| Byte | Bits | Field | Enum |
|---|---|---|---|
| 0 | `7\|8` | `NavKey` | 0=Up · 1=Down · 2=Left · 3=Right · 4=Select · 5=Back · 6=Home · 7=Menu |

**CAN IDs:** `0x100` / `0x110` / `0x120`

**Auto-wake:** if no Electron GUI is currently connected to the Playbill
controller, the *first* `NavCmd` frame triggers `system.launchGui` automatically
and is **not delivered as a navigation event**. Electron takes a few seconds to
attach to the IPC socket; subsequent frames navigate normally. Treat this like
the first press on an Apple-TV-style remote — it wakes the box.

### PlaybillTransportCmd — Play/pause/seek

| Offset | Direction | Size |
|---|---|---|
| `+0x1` | → Playbill | 5 bytes |

| Byte | Bits | Field | Notes |
|---|---|---|---|
| 0 | `7\|8` | `Action` | 0=Play · 1=Pause · 2=Stop · 3=Toggle · 4=SeekRel · 5=SeekAbs · 6=Next · 7=Previous |
| 1–4 | `15\|32` | `Value` | 32-bit BE. Used for SeekRel (signed-as-unsigned ms: `0x80000000 + delta_ms`) and SeekAbs (absolute ms). Unused for the other actions — send zeros. |

**CAN IDs:** `0x101` / `0x111` / `0x121`

### PlaybillSystemCmd — Power / window lifecycle

| Offset | Direction | Size |
|---|---|---|
| `+0x6` | → Playbill | 1 byte |

| Byte | Bits | Field | Enum |
|---|---|---|---|
| 0 | `7\|8` | `SysAction` | 0=LaunchGui · 1=QuitGui · 2=Focus · 3=Wake · 4=Sleep |

**CAN IDs:** `0x106` / `0x116` / `0x126`

`LaunchGui` is the explicit "power on" — use this from a dedicated power button
on your remote if you don't want to rely on the nav-press auto-wake.

### PlaybillLaunchSourceCmd — "Open this app"

| Offset | Direction | Size |
|---|---|---|
| `+0x7` | → Playbill | 2 bytes |

| Byte | Bits | Field | Enum |
|---|---|---|---|
| 0 | `7\|8` | `SourceEnum` | 0=None · 1=YouTube · 2=LiveTV · 3=Radio · 4=LocalLibrary · 5=Plex · 6=Spotify · 7=Netflix |
| 1 | `15\|8` | `SubScreenEnum` | 0=Default · 1=SignIn · 2=Settings · 3=Search |

**CAN IDs:** `0x107` / `0x117` / `0x127`

Implies `LaunchGui` plus navigate. The Sub-screen field is optional; send 0 if
you just want "open this source at its landing page."

### PlaybillVolumeCmd — Volume + mute (split out from TransportCmd)

| Offset | Direction | Size |
|---|---|---|
| `+0x8` | → Playbill | 2 bytes |

| Byte | Bits | Field | Notes |
|---|---|---|---|
| 0 | `7\|8` | `VolAction` | 0=Up · 1=Down · 2=Set · 3=MuteOn · 4=MuteOff · 5=MuteToggle |
| 1 | `15\|8` | `Value` | For Up/Down: step in percent (1–100, 0 = default 5). For Set: target percent 0–100. Ignored for the mute actions. |

**CAN IDs:** `0x108` / `0x118` / `0x128`

Deliberately separate from `TransportCmd` so a hardware volume encoder or mute
button can wire to a single CAN ID with no enum-parsing logic.

### PlaybillPresence — Heartbeat (read-only)

This is the Playbill *publishing* to the bus, not the MCU writing to it. Mirrors
the shape of the `FirmwareVersionReport` (CAN 0x004): last three bytes of the
host's primary NIC MAC + version triplet. Cycle time 60 s.

| Offset | Direction | Size |
|---|---|---|
| `+0x9` | ← Playbill | 6 bytes |

**CAN IDs:** `0x109` / `0x119` / `0x129`

Listen for this if you want to know which Playbills are alive on the bus
without parsing MQTT.

---

## 3 · Examples

### C / ESP-IDF — press Home (instance 0)

```c
#include <stdint.h>
#include "driver/twai.h"

void playbill_press_home(void) {
    twai_message_t msg = { 0 };
    msg.identifier        = 0x100;          // PlaybillNavCmd0
    msg.flags             = TWAI_MSG_FLAG_NONE;
    msg.data_length_code  = 1;
    msg.data[0]           = 6;              // NavKey.Home
    twai_transmit(&msg, pdMS_TO_TICKS(50));
}
```

### C / ESP-IDF — wake Playbill 0

```c
void playbill_power_on(void) {
    twai_message_t msg = { 0 };
    msg.identifier        = 0x106;          // PlaybillSystemCmd0
    msg.flags             = TWAI_MSG_FLAG_NONE;
    msg.data_length_code  = 1;
    msg.data[0]           = 0;              // SysAction.LaunchGui
    twai_transmit(&msg, pdMS_TO_TICKS(50));
}
```

### Python / SocketCAN — same two presses

```python
import can

bus = can.interface.Bus(interface='socketcan', channel='can0', bitrate=500000)

# Press Home on Playbill 0
bus.send(can.Message(arbitration_id=0x100, data=[6], is_extended_id=False))

# Power on Playbill 0
bus.send(can.Message(arbitration_id=0x106, data=[0], is_extended_id=False))
```

### Python — set volume to 50% on Playbill 1

```python
# PlaybillVolumeCmd1 = base 0x110 + offset 0x8
bus.send(can.Message(arbitration_id=0x118, data=[2, 50], is_extended_id=False))
#                                                ^^   ^^
#                                            VolAction.Set  percent
```

---

## 4 · Frequently asked

**Q. My MCU only has one button — can it both wake the Playbill and navigate?**
Yes. Send `NavCmd.Select` (`0x100` with byte 0 = 4) every press. The first press
wakes a cold Playbill and is consumed by `system.launchGui`; subsequent presses
land as Select. This is the default Apple-TV remote behavior.

**Q. Do I have to know the Playbill's deviceId?**
No. CAN uses numeric instance addressing (`canInstance` = 0/1/2). MQTT uses a
human-readable slug (`device.id`). They're independent. CAN-only MCUs never see
the slug.

**Q. What if there are multiple Playbills on the bus and my MCU only sends to
`0x100`?**
Then only Playbill instance 0 responds. Instances 1 and 2 ignore the frame.
This is by design — each instance binds to exactly one block.

**Q. Can I read the current radio frequency / volume from CAN?**
Yes, via the corresponding `*Status` messages — `PlaybillRadioStatus` (`+0x4`),
`PlaybillTransportStatus` (`+0x2`), `PlaybillScreenStatus` (`+0x5`). Layouts in
the DBC. Be aware: status messages are edge-triggered (republished only when
state changes), so cache the last value and re-request via the matching command
if you need a synchronous read.

**Q. Is there a CAN-side `Forget`/unclaim?**
No. Re-onboarding a Playbill is a Headwaters-driven flow (mDNS + claim). The
CAN bus doesn't speak provisioning.

---

## 5 · Related reading

- [TrailCurrent.dbc](../../TrailCurrentDocumentation/TrailCurrent.dbc) — canonical wire layout.
- [Playbill `docs/app/dbc-additions.md`](../../TrailCurrentPlaybill/docs/app/dbc-additions.md) — narrative + bit-position rationale + the per-instance block decision.
- [Playbill `docs/app/architecture.md`](../../TrailCurrentPlaybill/docs/app/architecture.md) §1 — why Headwaters stays wire-only on CAN and the Playbill owns its own DBC encoding.
