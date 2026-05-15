"""
time-from-bearing.py — Sync system clock from Bearing GNSS time over MQTT.

Headwaters runs chronyd as the LAN NTP server and as a client of public
NTP pools when internet is reachable. This service is the no-internet
fallback: when Bearing has a satellite fix, it publishes the GNSS UTC
date/time on the CAN bus, which the on-host can-to-mqtt bridge republishes
on the MQTT `can/inbound` topic. We watch for those frames and, if the
system clock is clearly wrong, step it via clock_settime so chronyd can
resume normal slewing from a correct starting point.

Bearing CAN frames consumed here:
  0x06 DateTime  [year_h, year_l, month, day, hour, minute, second]   UTC
  0x07 NavStat   [sats, speed_h, speed_l, course_h, course_l, gnss_mode]

NOTE on fix-validity: the GNSS module's `gnss_mode` byte is the
configured constellation (1=GPS, 2=Beidou, 3=GPS+Beidou, ...) - it is
NOT a fix-valid flag. The module broadcasts a datetime continuously
even while it is still cold-starting, and the values are nonsense (or
stuck at the module's epoch) until the first satellite lock provides
time. The right validity signal is the satellite-count byte (0x07
byte 0).

A 0x06 frame is only acted on when:
  (a) a 0x07 frame in the last GNSS_VALIDITY_TIMEOUT_SEC seconds
      reported at least MIN_SATELLITES satellites in-use,
  (b) the year decodes to something plausible (2025..2100),
  (c) the system-clock offset exceeds DRIFT_THRESHOLD_SEC, and
  (d) we have not already stepped the clock within the last
      MIN_INTERVAL_SEC.
The intent is to intervene only when something is obviously wrong —
chronyd handles the steady state.
"""

import ctypes
import ctypes.util
import json
import logging
import os
import re
import signal
import ssl
import sys
import time
import traceback
from datetime import datetime, timezone

import paho.mqtt.client as mqtt

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ENV_FILE = os.path.join(SCRIPT_DIR, ".env")
CA_CERT_PATH = os.path.join(SCRIPT_DIR, "ca.pem")
MQTT_INBOUND_TOPIC = "can/inbound"

CAN_ID_DATETIME = "0x006"
CAN_ID_NAVSTAT = "0x007"

# Only step the clock if drift exceeds this offset
DRIFT_THRESHOLD_SEC = 5.0
# Refuse to re-step more often than this (debounces a chrony-fight)
MIN_INTERVAL_SEC = 60.0
# Reject a 0x06 frame unless a 0x07 frame in the last N seconds confirmed the fix
GNSS_VALIDITY_TIMEOUT_SEC = 10.0
# Minimum satellites in-use to trust Bearing's GNSS time. 3 is enough for a 2D
# fix; the module reports a stuck datetime (year=0 or factory epoch) before it
# first locks. The year-range filter below is the secondary backstop.
MIN_SATELLITES = 3

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
)
log = logging.getLogger("time-from-bearing")

# ---------------------------------------------------------------------------
# clock_settime via libc — requires CAP_SYS_TIME (root)
# ---------------------------------------------------------------------------
CLOCK_REALTIME = 0


class _Timespec(ctypes.Structure):
    _fields_ = [("tv_sec", ctypes.c_long), ("tv_nsec", ctypes.c_long)]


_libc = ctypes.CDLL(ctypes.util.find_library("c"), use_errno=True)


def set_system_clock(epoch_seconds: float) -> None:
    ts = _Timespec()
    ts.tv_sec = int(epoch_seconds)
    ts.tv_nsec = int(round((epoch_seconds - ts.tv_sec) * 1_000_000_000))
    if _libc.clock_settime(CLOCK_REALTIME, ctypes.byref(ts)) != 0:
        err = ctypes.get_errno()
        raise OSError(err, os.strerror(err))


# ---------------------------------------------------------------------------
# .env loader (matches can-to-mqtt.py style)
# ---------------------------------------------------------------------------
def load_env(path: str) -> None:
    if not os.path.isfile(path):
        log.warning("No .env file found at %s", path)
        return
    with open(path) as f:
        for line in f:
            line = line.strip().strip("\r")
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ[k.strip()] = v.strip()


load_env(ENV_FILE)

MQTT_BROKER_URL = os.environ.get("MQTT_BROKER_URL", "")
_match = re.match(r"(mqtts?)://([^:]+):(\d+)", MQTT_BROKER_URL)
if not _match:
    log.error("Invalid or missing MQTT_BROKER_URL: %r", MQTT_BROKER_URL)
    sys.exit(1)
USE_TLS = _match.group(1) == "mqtts"
MQTT_HOST = _match.group(2)
MQTT_PORT = int(_match.group(3))
MQTT_USERNAME = os.environ.get("MQTT_USERNAME", "")
MQTT_PASSWORD = os.environ.get("MQTT_PASSWORD", "")
if not MQTT_USERNAME or not MQTT_PASSWORD:
    log.error("MQTT_USERNAME and MQTT_PASSWORD must be set in %s", ENV_FILE)
    sys.exit(1)

# ---------------------------------------------------------------------------
# State + signals
# ---------------------------------------------------------------------------
state = {
    "satellites": 0,
    "fix_ts": 0.0,
    "last_set_ts": 0.0,
}
shutdown_requested = False


def handle_signal(signum, _frame):
    global shutdown_requested
    log.info("Received signal %d, shutting down", signum)
    shutdown_requested = True


# ---------------------------------------------------------------------------
# can-to-mqtt encodes each CAN byte as an array of 8 bits, MSB first.
# Decode back to a list of byte values.
# ---------------------------------------------------------------------------
def bits_to_bytes(bit_arrays):
    out = []
    for ba in bit_arrays:
        v = 0
        for i, bit in enumerate(ba):
            v |= (int(bit) & 1) << (7 - i)
        out.append(v)
    return out


# ---------------------------------------------------------------------------
# MQTT callbacks
# ---------------------------------------------------------------------------
def on_connect(client, _userdata, _flags, reason_code, _properties):
    if reason_code == 0:
        log.info("Connected to MQTT %s:%d", MQTT_HOST, MQTT_PORT)
        client.subscribe(MQTT_INBOUND_TOPIC)
    else:
        log.error("MQTT connect failed: %s", reason_code)


def on_disconnect(_client, _userdata, _flags, reason_code, _properties):
    if reason_code != 0:
        log.warning("MQTT disconnected (rc=%s), auto-reconnecting", reason_code)


def on_message(_client, _userdata, msg):
    try:
        payload = json.loads(msg.payload.decode("utf-8"))
    except Exception as exc:
        log.debug("Bad JSON payload: %s", exc)
        return

    ident = payload.get("identifier")
    if not ident:
        return

    try:
        data = bits_to_bytes(payload.get("data") or [])
    except Exception as exc:
        log.debug("Bad data field: %s", exc)
        return
    dlc = int(payload.get("data_length_code", len(data)))

    if ident == CAN_ID_NAVSTAT and dlc >= 6:
        # Byte 0 of 0x07 is satellites-in-use. Byte 5 is the configured
        # constellation mode (NOT a fix flag) so we ignore it for validity.
        state["satellites"] = data[0]
        state["fix_ts"] = time.time()
        return

    if ident == CAN_ID_DATETIME and dlc >= 7:
        now = time.time()
        if (now - state["fix_ts"]) > GNSS_VALIDITY_TIMEOUT_SEC:
            return  # no recent 0x07 frame — can't confirm fix state
        if state["satellites"] < MIN_SATELLITES:
            return  # too few satellites in-use, Bearing's clock isn't trustworthy
        year = (data[0] << 8) | data[1]
        month, day, hour, minute, second = data[2], data[3], data[4], data[5], data[6]
        if not (2025 <= year <= 2100):
            return
        try:
            dt = datetime(year, month, day, hour, minute, second, tzinfo=timezone.utc)
        except ValueError:
            return  # rejected invalid date components

        bearing_epoch = dt.timestamp()
        delta = bearing_epoch - now
        if abs(delta) < DRIFT_THRESHOLD_SEC:
            return
        if (now - state["last_set_ts"]) < MIN_INTERVAL_SEC:
            return

        log.warning(
            "System clock differs from Bearing GNSS by %+.3f s "
            "(system=%s, bearing=%s, sats=%d); stepping",
            delta,
            datetime.fromtimestamp(now, tz=timezone.utc).isoformat(timespec="seconds"),
            dt.isoformat(timespec="seconds"),
            state["satellites"],
        )
        try:
            set_system_clock(bearing_epoch)
            state["last_set_ts"] = time.time()
        except OSError as exc:
            log.error("clock_settime failed: %s", exc)


# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------
def main():
    signal.signal(signal.SIGTERM, handle_signal)
    signal.signal(signal.SIGINT, handle_signal)

    client = mqtt.Client(
        callback_api_version=mqtt.CallbackAPIVersion.VERSION2,
        protocol=mqtt.MQTTv311,
    )
    client.username_pw_set(MQTT_USERNAME, MQTT_PASSWORD)
    if USE_TLS:
        client.tls_set(
            ca_certs=CA_CERT_PATH,
            cert_reqs=ssl.CERT_REQUIRED,
            tls_version=ssl.PROTOCOL_TLSv1_2,
        )
    client.on_connect = on_connect
    client.on_disconnect = on_disconnect
    client.on_message = on_message
    client.reconnect_delay_set(min_delay=1, max_delay=30)
    client.connect(MQTT_HOST, MQTT_PORT, 60)
    client.loop_start()
    try:
        while not shutdown_requested:
            time.sleep(1)
    finally:
        client.loop_stop()
        client.disconnect()


if __name__ == "__main__":
    while not shutdown_requested:
        try:
            main()
            if shutdown_requested:
                break
            time.sleep(5)
        except Exception as exc:
            log.error("Main loop crashed: %s", exc)
            with open(os.path.join(SCRIPT_DIR, "time-from-bearing-crash.log"), "a") as f:
                f.write(f"\n---\nError: {exc}\n")
                f.write(traceback.format_exc())
            time.sleep(30)
