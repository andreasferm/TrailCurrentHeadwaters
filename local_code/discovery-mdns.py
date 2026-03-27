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
        addr = txt.get('addr', '0')
        canid = txt.get('canid', '0x00')
        fw = txt.get('fw', '0.0.0')

        # Avoid publishing duplicates within the same browse session
        global found_hostnames
        if hostname in found_hostnames:
            return
        found_hostnames.add(hostname)

        payload = {
            'hostname': hostname,
            'type': module_type,
            'addr': int(addr),
            'canid': canid,
            'fw': fw
        }

        print(f"[mDNS] Found module: {payload}")
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
    else:
        print(f"Failed to connect to MQTT broker: {reason_code}")


def on_disconnect(client, userdata, flags, reason_code, properties):
    if reason_code == 0:
        print("Disconnected from MQTT broker (clean)")
    else:
        print(f"Disconnected unexpectedly (rc={reason_code}), will auto-reconnect")


def confirm_module(hostname, mqtt_publish):
    """Call the module's /discovery/confirm endpoint and publish the result."""
    print(f"[Confirm] Calling http://{hostname}.local/discovery/confirm")
    try:
        req = Request(f"http://{hostname}.local/discovery/confirm", method='GET')
        resp = urlopen(req, timeout=10)
        body = resp.read().decode('utf-8').strip()
        print(f"[Confirm] Module {hostname} responded: {body}")
        result = {'hostname': hostname, 'success': True}
    except Exception as e:
        print(f"[Confirm] Failed to reach {hostname}: {e}")
        result = {'hostname': hostname, 'success': False, 'error': str(e)}

    mqtt_publish(MQTT_TOPIC_CONFIRM_RESPONSE, json.dumps(result), qos=1)


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
