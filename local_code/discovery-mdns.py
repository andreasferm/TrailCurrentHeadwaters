#!/usr/bin/env python3
"""
mDNS Discovery Browser for TrailCurrent modules.

Listens for MQTT commands to start/stop browsing for _trailcurrent._tcp
mDNS services. When a module is found, publishes its details to MQTT
so the backend can present them to the user.

Runs on the host (not in Docker) because mDNS service browsing requires
multicast UDP access on the local network.
"""

import json
import os
import re
import signal
import ssl
import sys
import threading
from urllib.request import urlopen, Request
from urllib.error import URLError
import time

import paho.mqtt.client as mqtt
from zeroconf import ServiceBrowser, ServiceInfo, Zeroconf

BROWSE_TIMEOUT_S = 35  # 5s buffer over firmware's 30s discovery timeout

MQTT_TOPIC_START = 'discovery/browse/start'
MQTT_TOPIC_STOP = 'discovery/browse/stop'
MQTT_TOPIC_FOUND = 'discovery/browse/found'
MQTT_TOPIC_CONFIRM_REQUEST = 'discovery/confirm/request'
MQTT_TOPIC_CONFIRM_RESPONSE = 'discovery/confirm/response'
# Playbill (Linux endpoint) onboarding — instead of an HTTP GET marker, the
# host POSTs broker credentials to the device so it can connect to the rig.
# Distinct topic pair so a future second non-MCU endpoint type doesn't
# overload the MCU confirm contract.
MQTT_TOPIC_CLAIM_REQUEST = 'discovery/claim/request'
MQTT_TOPIC_CLAIM_RESPONSE = 'discovery/claim/response'

shutdown_requested = False
browse_lock = threading.Lock()
active_browser = None
active_zeroconf = None
browse_timer = None
found_hostnames = set()


def handle_signal(signum, frame):
    global shutdown_requested
    print(f"Received signal {signum}, shutting down...")
    shutdown_requested = True


# Load .env file from script directory
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ENV_FILE = os.path.join(SCRIPT_DIR, '.env')
if os.path.isfile(ENV_FILE):
    with open(ENV_FILE) as f:
        for line in f:
            line = line.strip().strip('\r')
            if line and not line.startswith('#') and '=' in line:
                key, value = line.split('=', 1)
                os.environ[key.strip()] = value.strip()
    print(f"Loaded env from {ENV_FILE}")
else:
    print(f"Warning: No .env file found at {ENV_FILE}")

# MQTT settings
MQTT_BROKER_URL = os.environ.get('MQTT_BROKER_URL')
if not MQTT_BROKER_URL:
    print('ERROR: MQTT_BROKER_URL environment variable must be set', file=sys.stderr)
    sys.exit(1)

match = re.match(r'(mqtts?)://([^:]+):(\d+)', MQTT_BROKER_URL)
if not match:
    print(f'ERROR: Invalid MQTT_BROKER_URL format: {MQTT_BROKER_URL}', file=sys.stderr)
    sys.exit(1)

protocol = match.group(1)
MQTT_BROKER = match.group(2)
MQTT_PORT = int(match.group(3))
USE_TLS = (protocol == 'mqtts')
MQTT_CA_CERT_PATH = os.path.join(SCRIPT_DIR, 'ca.pem')

MQTT_USERNAME = os.environ.get('MQTT_USERNAME')
if not MQTT_USERNAME:
    print('ERROR: MQTT_USERNAME environment variable must be set', file=sys.stderr)
    sys.exit(1)

MQTT_PASSWORD = os.environ.get('MQTT_PASSWORD')
if not MQTT_PASSWORD:
    print('ERROR: MQTT_PASSWORD environment variable must be set', file=sys.stderr)
    sys.exit(1)

mqtt_client = None


class TrailCurrentListener:
    """Zeroconf service listener for _trailcurrent._tcp services."""

    def __init__(self, zc, mqtt_pub):
        self.zc = zc
        self.mqtt_pub = mqtt_pub

    def add_service(self, zc, service_type, name):
        info = zc.get_service_info(service_type, name)
        if info is None:
            print(f"[mDNS] Service found but could not resolve: {name}")
            return

        hostname = info.server.rstrip('.')
        # Remove .local suffix if present for storage
        if hostname.endswith('.local'):
            hostname = hostname[:-6]

        # Parse TXT records
        txt = {}
        if info.properties:
            for k, v in info.properties.items():
                key = k.decode('utf-8') if isinstance(k, bytes) else k
                val = v.decode('utf-8') if isinstance(v, bytes) else str(v)
                txt[key] = val

        module_type = txt.get('type', 'unknown')
        fw = txt.get('fw', '0.0.0')

        # Avoid publishing duplicates within the same browse session
        global found_hostnames
        if hostname in found_hostnames:
            return
        found_hostnames.add(hostname)

        payload = {
            'hostname': hostname,
            'type': module_type,
            'fw': fw,
        }

        # ESP32 MCU modules advertise addr (int) and canid (hex string). Linux
        # endpoints (Playbill) don't have either — they identify by hostname
        # and their MQTT slug. Keep addr/canid optional so a Playbill TXT
        # record without them parses cleanly.
        if 'addr' in txt:
            try:
                payload['addr'] = int(txt['addr'])
            except ValueError:
                payload['addr'] = 0
        if 'canid' in txt:
            payload['canid'] = txt['canid']

        # Optional extras some advertisers include:
        #   target       — Tapper variant ("torrent" / "switchback")
        #   name         — friendly display name (Playbill)
        #   deviceId     — stable MQTT topic slug (Playbill)
        #   canInstance  — Playbill's CAN block selection (0/1/2 or absent)
        for key in ('target', 'name', 'deviceId', 'canInstance'):
            if key in txt:
                payload[key] = txt[key]

        # Discovery hints the front-end uses to render the card and pick the
        # right onboarding flow:
        #   confirm — MCU pattern: HTTP GET /discovery/confirm marker (default)
        #   claim   — Linux pattern: HTTP POST /discovery/claim with creds
        if module_type == 'playbill':
            payload['onboard'] = 'claim'
        else:
            payload['onboard'] = 'confirm'

        print(f"[mDNS] Found device: {payload}")
        self.mqtt_pub(MQTT_TOPIC_FOUND, json.dumps(payload), qos=1)

    def remove_service(self, zc, service_type, name):
        pass

    def update_service(self, zc, service_type, name):
        pass


def stop_browsing():
    """Stop the active mDNS browse session."""
    global active_browser, active_zeroconf, browse_timer, found_hostnames

    with browse_lock:
        if browse_timer:
            browse_timer.cancel()
            browse_timer = None

        if active_browser:
            print("[mDNS] Stopping browse session")
            active_browser.cancel()
            active_browser = None

        if active_zeroconf:
            active_zeroconf.close()
            active_zeroconf = None

        found_hostnames = set()


def start_browsing(mqtt_publish):
    """Start a new mDNS browse session."""
    global active_browser, active_zeroconf, browse_timer, found_hostnames

    # Stop any existing session first
    stop_browsing()

    with browse_lock:
        found_hostnames = set()
        print(f"[mDNS] Starting browse for _trailcurrent._tcp (timeout {BROWSE_TIMEOUT_S}s)")

        active_zeroconf = Zeroconf()
        listener = TrailCurrentListener(active_zeroconf, mqtt_publish)
        active_browser = ServiceBrowser(active_zeroconf, "_trailcurrent._tcp.local.", listener)

        # Auto-stop after timeout
        browse_timer = threading.Timer(BROWSE_TIMEOUT_S, stop_browsing)
        browse_timer.daemon = True
        browse_timer.start()


def on_connect(client, userdata, flags, reason_code, properties):
    if reason_code == 0:
        print("Connected to MQTT broker")
        client.subscribe(MQTT_TOPIC_START)
        client.subscribe(MQTT_TOPIC_STOP)
        client.subscribe(MQTT_TOPIC_CONFIRM_REQUEST)
        client.subscribe(MQTT_TOPIC_CLAIM_REQUEST)
    else:
        print(f"Failed to connect to MQTT broker: {reason_code}")


def on_disconnect(client, userdata, flags, reason_code, properties):
    if reason_code == 0:
        print("Disconnected from MQTT broker (clean)")
    else:
        print(f"Disconnected unexpectedly (rc={reason_code}), will auto-reconnect")


def confirm_module(hostname, mqtt_publish):
    """Call the module's /discovery/confirm endpoint and publish the result.
    Retries up to 3 times for transient network errors (mDNS stale cache, etc.)."""
    url = f"http://{hostname}.local/discovery/confirm"
    max_attempts = 3
    last_error = None

    for attempt in range(1, max_attempts + 1):
        print(f"[Confirm] Attempt {attempt}/{max_attempts}: {url}")
        try:
            req = Request(url, method='GET')
            resp = urlopen(req, timeout=10)
            body = resp.read().decode('utf-8').strip()
            print(f"[Confirm] Module {hostname} responded: {body}")
            mqtt_publish(MQTT_TOPIC_CONFIRM_RESPONSE,
                         json.dumps({'hostname': hostname, 'success': True}), qos=1)
            return
        except Exception as e:
            last_error = e
            print(f"[Confirm] Attempt {attempt} failed for {hostname}: {e}")
            if attempt < max_attempts:
                time.sleep(2)

    print(f"[Confirm] All attempts failed for {hostname}: {last_error}")
    mqtt_publish(MQTT_TOPIC_CONFIRM_RESPONSE,
                 json.dumps({'hostname': hostname, 'success': False, 'error': str(last_error)}),
                 qos=1)


def claim_playbill(hostname, creds, mqtt_publish):
    """POST broker credentials to a discovered Playbill so it can connect
    to the rig's MQTT broker. Returns success/failure on
    discovery/claim/response.

    Body shape (must match what the Playbill controller's HTTP handler
    expects):
      {
        "brokerUrl":       "mqtts://headwaters.local:8883",
        "username":        "trailcurrent",
        "password":        "...",
        "caCertPem":       "-----BEGIN CERTIFICATE-----\\n...",
        "tlsCertHostname": "trailcurrent.local"
      }

    The Playbill is expected to persist these to
    ~/.config/trailcurrent-playbill/connection.json (and ca.pem), then
    reconnect its MQTT bridge. Success on the wire = HTTP 200; the rig sees
    the Playbill come online via its retained
    local/playbill/<deviceId>/system/status presence.
    """
    url = f"http://{hostname}.local/discovery/claim"
    max_attempts = 3
    last_error = None
    body = json.dumps(creds).encode('utf-8')

    for attempt in range(1, max_attempts + 1):
        print(f"[Claim] Attempt {attempt}/{max_attempts}: {url}")
        try:
            req = Request(url, data=body, method='POST',
                          headers={'Content-Type': 'application/json'})
            resp = urlopen(req, timeout=10)
            status = resp.getcode()
            payload = resp.read().decode('utf-8').strip()
            if 200 <= status < 300:
                print(f"[Claim] Playbill {hostname} accepted credentials (HTTP {status})")
                mqtt_publish(MQTT_TOPIC_CLAIM_RESPONSE,
                             json.dumps({'hostname': hostname, 'success': True}),
                             qos=1)
                return
            last_error = RuntimeError(f"HTTP {status}: {payload[:200]}")
        except Exception as e:
            last_error = e
            print(f"[Claim] Attempt {attempt} failed for {hostname}: {e}")
        if attempt < max_attempts:
            time.sleep(2)

    print(f"[Claim] All attempts failed for {hostname}: {last_error}")
    mqtt_publish(MQTT_TOPIC_CLAIM_RESPONSE,
                 json.dumps({'hostname': hostname, 'success': False,
                             'error': str(last_error)}),
                 qos=1)


def on_message(client, userdata, msg):
    topic = msg.topic
    if topic == MQTT_TOPIC_START:
        print("[MQTT] Received discovery browse start command")
        start_browsing(client.publish)
    elif topic == MQTT_TOPIC_STOP:
        print("[MQTT] Received discovery browse stop command")
        stop_browsing()
    elif topic == MQTT_TOPIC_CONFIRM_REQUEST:
        try:
            data = json.loads(msg.payload.decode('utf-8'))
            hostname = data.get('hostname')
            if hostname:
                threading.Thread(
                    target=confirm_module,
                    args=(hostname, client.publish),
                    daemon=True
                ).start()
        except Exception as e:
            print(f"[Confirm] Error parsing request: {e}")
    elif topic == MQTT_TOPIC_CLAIM_REQUEST:
        try:
            data = json.loads(msg.payload.decode('utf-8'))
            hostname = data.get('hostname')
            creds    = data.get('creds')
            if not hostname or not isinstance(creds, dict):
                raise ValueError("hostname and creds (object) required")
            threading.Thread(
                target=claim_playbill,
                args=(hostname, creds, client.publish),
                daemon=True
            ).start()
        except Exception as e:
            print(f"[Claim] Error parsing request: {e}")
            # Best-effort error response — the requester is waiting on a
            # response with this hostname; without one it times out.
            try:
                client.publish(
                    MQTT_TOPIC_CLAIM_RESPONSE,
                    json.dumps({
                        'hostname': (data or {}).get('hostname') if 'data' in dir() else None,
                        'success': False,
                        'error': f"claim request malformed: {e}",
                    }),
                    qos=1,
                )
            except Exception:
                pass


def main():
    global shutdown_requested, mqtt_client

    signal.signal(signal.SIGTERM, handle_signal)
    signal.signal(signal.SIGINT, handle_signal)

    mqtt_client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)
    mqtt_client.username_pw_set(MQTT_USERNAME, MQTT_PASSWORD)

    if USE_TLS:
        mqtt_client.tls_set(
            ca_certs=MQTT_CA_CERT_PATH,
            cert_reqs=ssl.CERT_REQUIRED,
            tls_version=ssl.PROTOCOL_TLS_CLIENT,
        )
        mqtt_client.tls_insecure_set(False)

    mqtt_client.on_connect = on_connect
    mqtt_client.on_disconnect = on_disconnect
    mqtt_client.on_message = on_message

    print(f"Connecting to MQTT broker at {MQTT_BROKER}:{MQTT_PORT}...")
    mqtt_client.connect(MQTT_BROKER, MQTT_PORT)
    mqtt_client.loop_start()

    try:
        while not shutdown_requested:
            time.sleep(1)
    except KeyboardInterrupt:
        pass
    finally:
        print("Shutting down...")
        stop_browsing()
        mqtt_client.loop_stop()
        mqtt_client.disconnect()
        print("Shutdown complete")


if __name__ == '__main__':
    main()
