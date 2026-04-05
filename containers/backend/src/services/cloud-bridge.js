'use strict';

// Cloud MQTT Bridge — replaces Node-RED cloud-workflow.
// Manages a second MQTT client connecting to the cloud broker.
// Bridges local↔cloud messages with per-topic rate limiting.

const mqtt = require('mqtt');
const canBridge = require('./can-bridge');

let cloudClient = null;
let localClient = null;
let mqttServiceRef = null;
let rateLimitMs = 1000 / 30; // default 30 msgs/sec → ~33ms per message
const CONFIG_SYNC_RATE_MS = 5000;

// Per-topic timestamp map for rate limiting
const lastSent = {};

function shouldSend(topic, intervalMs) {
    const now = Date.now();
    if (now - (lastSent[topic] || 0) < intervalMs) return false;
    lastSent[topic] = now;
    return true;
}

// ── Local → Cloud status bridging (rate-limited) ────────────────────

const LOCAL_TO_CLOUD = [
    { local: 'local/lights/+/status',       cloudPrefix: 'rv/lights/',       cloudSuffix: '/status',    wildcard: true },
    { local: 'local/relays/+/status',        cloudPrefix: 'rv/relays/',       cloudSuffix: '/status',    wildcard: true },
    { local: 'local/airquality/status',      cloud: 'rv/airquality/status' },
    { local: 'local/airquality/temphumid',   cloud: 'rv/airquality/temphumid' },
    { local: 'local/gps/latlon',             cloud: 'rv/gps/latlon' },
    { local: 'local/gps/alt',               cloud: 'rv/gps/alt' },
    { local: 'local/gps/details',            cloud: 'rv/gps/details' },
    { local: 'local/gps/time',               cloud: 'rv/gps/time' },
    { local: 'local/energy/status',          cloud: 'rv/energy/status' },
    { local: 'local/thermostat/status',      cloud: 'rv/thermostat/status' },
    { local: 'local/level/tilt',             cloud: 'rv/level/tilt' },
    { local: 'local/level/status',           cloud: 'rv/level/status' },
    { local: 'local/config/pdm_channels',    cloud: 'rv/config/pdm_channels' },
    { local: 'local/system/stats',           cloud: 'rv/system/stats' }
];

// System config sync — retained, QoS 1, hardcoded 5s rate limit
const SYSTEM_SYNC = { local: 'local/config/system_sync', cloud: 'rv/config/system' };

// Local broker message handler — attached exactly once in connect().
// Must not be reattached on reconnect, or each message will be processed
// multiple times (fine for rate-limited status, fatal for toggles).
function handleLocalMessage(topic, message) {
    if (!cloudClient || !cloudClient.connected) return;

    // System config sync (retained, QoS 1, 5s rate limit)
    if (topic === SYSTEM_SYNC.local) {
        if (!shouldSend(SYSTEM_SYNC.cloud, CONFIG_SYNC_RATE_MS)) return;
        cloudClient.publish(SYSTEM_SYNC.cloud, message, { qos: 1, retain: true });
        return;
    }

    // Match against local→cloud mappings
    for (const mapping of LOCAL_TO_CLOUD) {
        if (mapping.wildcard) {
            // Pattern: local/lights/+/status → rv/lights/N/status
            const regex = new RegExp('^' + mapping.local.replace('+', '([^/]+)') + '$');
            const match = topic.match(regex);
            if (match) {
                const cloudTopic = mapping.cloudPrefix + match[1] + mapping.cloudSuffix;
                if (!shouldSend(cloudTopic, rateLimitMs)) return;
                cloudClient.publish(cloudTopic, message, { qos: 1 });
                return;
            }
        } else if (topic === mapping.local) {
            if (!shouldSend(mapping.cloud, rateLimitMs)) return;
            cloudClient.publish(mapping.cloud, message, { qos: 1 });
            return;
        }
    }
}

function subscribeLocalToCloud() {
    if (!localClient) return;

    // Subscribe to all local status topics (idempotent — safe to call on reconnect)
    for (const mapping of LOCAL_TO_CLOUD) {
        localClient.subscribe(mapping.local, { qos: 1 });
    }
    localClient.subscribe(SYSTEM_SYNC.local, { qos: 1 });
}

// ── Cloud → Local command routing ───────────────────────────────────

// Cloud broker message handler — attached exactly once per cloudClient.
// Critical: must NOT be reattached on reconnect, because individual
// light/relay commands are toggle-based. Duplicate listeners cause each
// toggle to be applied N times, so on an even count the light flickers
// back to its previous state — exactly the "sometimes works, sometimes
// doesn't" symptom. All On/Off and brightness are idempotent so they
// remain visually unaffected by listener leaks.
function handleCloudMessage(topic, message) {
    try {
        const payload = JSON.parse(message.toString());
        const parts = topic.split('/');

        if (parts[0] !== 'rv') return;

        if (parts[1] === 'lights') {
            if (parts[2] === 'all' && parts[3] === 'command') {
                // All lights on/off — uses CAN 0x018 with special address byte
                const state = payload.state ? 1 : 0;
                mqttServiceRef.publishCanMessage(0x018, [0x08, state]);
            } else if (parts[3] === 'command') {
                const lightId = parseInt(parts[2]);
                if (lightId >= 1 && lightId <= 8) {
                    canBridge.sendLightToggle(mqttServiceRef, lightId - 1);
                }
            } else if (parts[3] === 'brightness') {
                const lightId = parseInt(parts[2]);
                if (lightId >= 1 && lightId <= 8) {
                    const brightness = payload.brightness || 0;
                    canBridge.sendLightBrightness(mqttServiceRef, lightId - 1, brightness);
                }
            }
        } else if (parts[1] === 'relays') {
            if (parts[2] === 'all' && parts[3] === 'command') {
                canBridge.sendRelayAll(mqttServiceRef, payload.state);
            } else if (parts[3] === 'command') {
                const relayId = parseInt(parts[2]);
                if (relayId >= 1 && relayId <= 24) {
                    canBridge.sendRelayToggle(mqttServiceRef, relayId - 1);
                }
            }
        } else if (parts[1] === 'thermostat' && parts[2] === 'command') {
            // Pass through to local thermostat
            localClient.publish('local/thermostat/command', message, { qos: 1 });
        } else if (parts[1] === 'proximity') {
            // Pass through proximity events/status to local broker
            const localTopic = topic.replace('rv/', 'local/');
            localClient.publish(localTopic, message, { qos: 1 });
        }
    } catch (err) {
        console.error('[Cloud Bridge] Error handling cloud command:', err.message);
    }
}

function subscribeCloudToLocal() {
    if (!cloudClient) return;

    // Subscribe to cloud command topics (idempotent — safe to call on reconnect)
    cloudClient.subscribe('rv/lights/+/command', { qos: 1 });
    cloudClient.subscribe('rv/lights/+/brightness', { qos: 1 });
    cloudClient.subscribe('rv/lights/all/command', { qos: 1 });
    cloudClient.subscribe('rv/relays/+/command', { qos: 1 });
    cloudClient.subscribe('rv/relays/all/command', { qos: 1 });
    cloudClient.subscribe('rv/thermostat/command', { qos: 1 });
    cloudClient.subscribe('rv/proximity/event', { qos: 1 });
    cloudClient.subscribe('rv/proximity/status', { qos: 1 });
}

// ── Public API ──────────────────────────────────────────────────────

function connect(mqttService, domain, username, password) {
    mqttServiceRef = mqttService;
    localClient = mqttService.client;

    if (!localClient) {
        console.error('[Cloud Bridge] Local MQTT client not available');
        return;
    }

    // Disconnect existing cloud client if reconnecting with new creds
    if (cloudClient) {
        cloudClient.end(true);
        cloudClient = null;
    }

    const brokerUrl = `mqtts://${domain}:8883`;
    console.log(`[Cloud Bridge] Connecting to cloud broker at ${brokerUrl}`);

    cloudClient = mqtt.connect(brokerUrl, {
        clientId: `rv-cloud-bridge-${Date.now()}`,
        clean: true,
        reconnectPeriod: 5000,
        username,
        password,
        protocolVersion: 4,
        keepalive: 60,
        rejectUnauthorized: true   // Use system CA store (Let's Encrypt)
    });

    // Attach message listener exactly ONCE per client. mqtt.js fires 'connect'
    // on every reconnect, so attaching inside the connect handler would leak
    // a listener on each reconnect and cause duplicated toggle commands.
    cloudClient.on('message', handleCloudMessage);

    cloudClient.on('connect', () => {
        console.log('[Cloud Bridge] Connected to cloud broker');
        subscribeCloudToLocal();
        // Trigger config re-sync on cloud connect
        if (localClient && localClient.connected) {
            localClient.publish('local/config/system_sync_trigger',
                JSON.stringify({ reason: 'cloud_reconnect' }), { qos: 1 });
        }
    });

    cloudClient.on('error', (err) => {
        console.error('[Cloud Bridge] Cloud MQTT error:', err.message);
    });

    cloudClient.on('close', () => {
        console.log('[Cloud Bridge] Cloud connection closed');
    });

    // Set up local→cloud bridging. The message listener is attached to
    // localClient only once per connect() call — removeListener first to
    // keep this safe if connect() is re-invoked (e.g. credentials update).
    localClient.removeListener('message', handleLocalMessage);
    localClient.on('message', handleLocalMessage);
    subscribeLocalToCloud();
}

function disconnect() {
    if (cloudClient) {
        console.log('[Cloud Bridge] Disconnecting from cloud broker');
        cloudClient.end(true);
        cloudClient = null;
    }
    // Clear rate limit state
    for (const key of Object.keys(lastSent)) {
        delete lastSent[key];
    }
}

function updateRateLimit(msgsPerSec) {
    const clamped = Math.max(1, Math.min(100, msgsPerSec));
    rateLimitMs = 1000 / clamped;
    console.log(`[Cloud Bridge] Rate limit updated to ${clamped} msgs/sec (${rateLimitMs.toFixed(1)}ms interval)`);
}

module.exports = { connect, disconnect, updateRateLimit };
