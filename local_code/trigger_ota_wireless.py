#!/usr/bin/env python3
"""
Publish OTA trigger for a wireless MCU via MQTT.
Publishes the hostname string to local/ota/trigger.
The wireless device (e.g. Fireside) subscribes to this topic and enters
OTA mode when its own hostname matches.
"""

import paho.mqtt.client as mqtt
import sys
import os
from dotenv import load_dotenv
import re
import ssl

# Load .env from same directory as this script
env_path = os.path.join(os.path.dirname(__file__), '.env')
load_dotenv(env_path)

MQTT_BROKER_URL = os.getenv('MQTT_BROKER_URL', 'mqtts://mosquitto:8883')
MQTT_USER = os.getenv('MQTT_USERNAME')
MQTT_PASS = os.getenv('MQTT_PASSWORD')

match = re.match(r'(mqtts?)://([^:]+):(\d+)', MQTT_BROKER_URL)
if not match:
    print(f'ERROR: Invalid MQTT_BROKER_URL format: {MQTT_BROKER_URL}', file=sys.stderr)
    sys.exit(1)

protocol = match.group(1)
MQTT_HOST = match.group(2)
MQTT_PORT = int(match.group(3))
USE_TLS = (protocol == 'mqtts')

MQTT_CA_CERT_PATH = os.path.join(os.path.dirname(__file__), 'ca.pem')

TOPIC = 'local/ota/trigger'


def publish_wireless_ota_trigger(hostname):
    """Publish hostname string to local/ota/trigger."""
    try:
        client = mqtt.Client(
            callback_api_version=mqtt.CallbackAPIVersion.VERSION2,
            protocol=mqtt.MQTTv311
        )
        client.username_pw_set(MQTT_USER, MQTT_PASS)

        if USE_TLS:
            client.tls_set(
                ca_certs=MQTT_CA_CERT_PATH,
                certfile=None,
                keyfile=None,
                cert_reqs=ssl.CERT_REQUIRED,
                tls_version=ssl.PROTOCOL_TLSv1_2
            )

        client.connect(MQTT_HOST, MQTT_PORT, 60)

        print(f'Publishing wireless OTA trigger: {TOPIC} -> {hostname}')
        client.publish(TOPIC, hostname)
        client.disconnect()

        print(f'Wireless OTA trigger sent to {hostname}')
        return 0

    except Exception as e:
        print(f'Error: Failed to publish wireless OTA trigger: {e}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    if len(sys.argv) != 2:
        print('Usage: trigger_ota_wireless.py <hostname>', file=sys.stderr)
        sys.exit(1)

    hostname_arg = sys.argv[1]
    if not re.match(r'^esp32-[0-9A-Fa-f]{6}$', hostname_arg):
        print(f'ERROR: Invalid hostname format: {hostname_arg}', file=sys.stderr)
        print('Expected format: esp32-XXYYZZ (last 3 MAC bytes as hex)', file=sys.stderr)
        sys.exit(1)

    sys.exit(publish_wireless_ota_trigger(hostname_arg))
