const express = require('express');
const router = express.Router();
const { decrypt } = require('../utils/crypto.js');
const mqttService = require('../mqtt');
const { syncPdmChannelsToLights } = require('../services/pdm-channel-sync.js');
const { syncSwitchbackChannelsToLights } = require('../services/switchback-channel-sync.js');
const { MCU_MODULES, VALID_MODULE_IDS } = require('./modules');

const MODULE_DISPLAY_NAMES = Object.fromEntries(MCU_MODULES.map(m => [m.id, m.name]));

// Ephemeral discovery session state
let discoveredModules = [];
let discoveryActive = false;
let discoveryTimeout = null;

// Pending confirm callbacks: hostname -> { resolve, reject, timer }
const pendingConfirms = new Map();

module.exports = (db) => {
    const systemConfig = db.collection('system_config');

    // POST /api/discovery/start — Broadcast WiFi creds + CAN 0x02, start mDNS browse
    router.post('/start', async (req, res) => {
        try {
            // Read WiFi credentials from system config
            const config = await systemConfig.findOne({ _id: 'main' });
            // Ignore if already scanning
            if (discoveryActive) {
                return res.json({ success: true, message: 'Discovery already active' });
            }

            // Check MQTT is connected before proceeding
            if (!mqttService.connected) {
                return res.status(503).json({ error: 'MQTT broker not connected' });
            }

            // Clear previous session
            discoveredModules = [];
            discoveryActive = true;

            // Auto-reset discoveryActive after timeout (safety net if frontend disconnects)
            if (discoveryTimeout) clearTimeout(discoveryTimeout);
            discoveryTimeout = setTimeout(() => {
                if (discoveryActive) {
                    console.log('[Discovery] Auto-stopping after timeout');
                    discoveryActive = false;
                    mqttService.publishDiscoveryBrowseStop();
                }
            }, 40000);

            // Broadcast WiFi credentials first, then trigger discovery after they finish
            if (config && config.wifi_ssid && config.wifi_password_encrypted && config.wifi_password_iv) {
                try {
                    const password = decrypt(config.wifi_password_encrypted, config.wifi_password_iv);
                    if (config.wifi_ssid && password) {
                        console.log('[Discovery] Broadcasting WiFi credentials via CAN 0x01');
                        await mqttService.publishWifiCredentials(config.wifi_ssid, password);
                    }
                } catch (err) {
                    console.error('[Discovery] Failed to decrypt WiFi password:', err.message);
                }
            }

            mqttService.publishDiscoveryTrigger();
            mqttService.publishDiscoveryBrowseStart();

            res.json({ success: true, message: 'Discovery started' });
        } catch (error) {
            console.error('Error starting discovery:', error);
            res.status(500).json({ error: 'Failed to start discovery' });
        }
    });

    // GET /api/discovery/found — Return modules found so far
    router.get('/found', (req, res) => {
        res.json({
            active: discoveryActive,
            modules: discoveredModules
        });
    });

    // POST /api/discovery/confirm — Confirm a discovered module and save it
    router.post('/confirm', async (req, res) => {
        try {
            const { hostname } = req.body;

            if (!hostname || typeof hostname !== 'string') {
                return res.status(400).json({ error: 'hostname is required' });
            }

            // Find the module in discovered list
            const found = discoveredModules.find(m => m.hostname === hostname);
            if (!found) {
                return res.status(404).json({ error: 'Module not found in discovered list' });
            }

            // Validate module type
            if (!VALID_MODULE_IDS.includes(found.type)) {
                return res.status(400).json({ error: `Unknown module type: ${found.type}` });
            }

            // Confirm via host-side proxy (Docker can't resolve .local mDNS names)
            // Backend publishes request to MQTT, host-side script calls the module,
            // publishes result back
            try {
                await confirmViaProxy(hostname);
            } catch (confirmErr) {
                console.error(`[Discovery] Confirm failed for ${hostname}:`, confirmErr.message);
                return res.status(502).json({ error: confirmErr.message });
            }

            // Read current modules
            const config = await systemConfig.findOne({ _id: 'main' });
            const modules = (config && config.mcu_modules) || [];

            // Check for duplicate hostname
            if (modules.some(m => m.hostname === hostname)) {
                return res.status(409).json({ error: 'Module with this hostname already exists' });
            }

            // Generate auto-name
            const name = generateModuleName(found.type, found.addr, modules);

            // Build module record
            const newModule = {
                type: found.type,
                name: name,
                hostname: found.hostname,
                addr: found.addr,
                canid: found.canid,
                fw: found.fw,
                enabled: true,
                config: {}
            };
            if (found.target) newModule.target = found.target;

            // Add to mcu_modules array
            modules.push(newModule);

            // Check if we need to rename the first module of this type
            // (when a second one is added, the first should get its addr suffix too)
            const sameType = modules.filter(m => m.type === found.type);
            if (sameType.length === 2) {
                const first = sameType[0];
                const displayName = MODULE_DISPLAY_NAMES[first.type] || first.type;
                const addr = first.addr !== undefined ? first.addr : 0;
                const paddedAddr = String(addr).padStart(2, '0');
                // Only rename if it doesn't already have the addr suffix
                if (first.name === displayName) {
                    first.name = `${displayName} ${paddedAddr}`;
                }
            }

            await systemConfig.updateOne(
                { _id: 'main' },
                { $set: { mcu_modules: modules, updated_at: new Date() } }
            );

            // Trigger channel sync for relevant module types
            try {
                if (found.type === 'torrent') {
                    await syncPdmChannelsToLights(db, mqttService);
                }
                if (found.type === 'switchback' || found.type === 'switchback_relay') {
                    await syncSwitchbackChannelsToLights(db, mqttService);
                    await mqttService.refreshRelayNameCache();
                }
            } catch (syncErr) {
                console.error('[Discovery] Channel sync error:', syncErr.message);
            }

            // Remove from discovered list
            discoveredModules = discoveredModules.filter(m => m.hostname !== hostname);

            res.json({ success: true, module: newModule });
        } catch (error) {
            console.error('Error confirming module:', error);
            res.status(500).json({ error: 'Failed to confirm module' });
        }
    });

    // POST /api/discovery/stop — Stop the mDNS browse session
    router.post('/stop', (req, res) => {
        discoveryActive = false;
        if (discoveryTimeout) { clearTimeout(discoveryTimeout); discoveryTimeout = null; }
        mqttService.publishDiscoveryBrowseStop();
        res.json({ success: true, message: 'Discovery stopped' });
    });

    // POST /api/discovery/reset — Reset a module's configured flag via CAN 0x03
    router.post('/reset', (req, res) => {
        try {
            const { hostname } = req.body;

            if (!hostname || typeof hostname !== 'string') {
                return res.status(400).json({ error: 'hostname is required' });
            }

            const success = mqttService.publishDiscoveryReset(hostname);
            if (!success) {
                return res.status(503).json({ error: 'Failed to send discovery reset' });
            }

            res.json({ success: true, message: `Discovery reset sent to ${hostname}` });
        } catch (error) {
            console.error('Error resetting module:', error);
            res.status(500).json({ error: 'Failed to reset module' });
        }
    });

    return router;
};

/**
 * Register a module found via MQTT (called from mqtt.js handler).
 * Adds to the ephemeral discovered list if discovery is active.
 */
module.exports.addDiscoveredModule = function(moduleData) {
    if (!discoveryActive) return;

    // Avoid duplicates
    if (discoveredModules.some(m => m.hostname === moduleData.hostname)) return;

    const entry = {
        hostname: moduleData.hostname,
        type: moduleData.type,
        addr: moduleData.addr,
        canid: moduleData.canid,
        fw: moduleData.fw,
        discovered_at: new Date().toISOString()
    };
    if (moduleData.target) entry.target = moduleData.target;
    discoveredModules.push(entry);
};

/**
 * Generate a display name for a module.
 * Single instance: "Picket"
 * Multiple instances or addr > 1: "Picket 03"
 */
/**
 * Send confirm request to host-side proxy via MQTT and wait for response.
 * Returns a promise that resolves on success or rejects on failure/timeout.
 */
function confirmViaProxy(hostname) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            pendingConfirms.delete(hostname);
            reject(new Error(`Confirm timed out for ${hostname}`));
        }, 40000);

        pendingConfirms.set(hostname, { resolve, reject, timer });

        mqttService.publishDiscoveryConfirmRequest(hostname);
    });
}

/**
 * Handle confirm response from host-side proxy (called from mqtt.js).
 */
module.exports.handleConfirmResponse = function(data) {
    const pending = pendingConfirms.get(data.hostname);
    if (!pending) return;

    clearTimeout(pending.timer);
    pendingConfirms.delete(data.hostname);

    if (data.success) {
        pending.resolve();
    } else {
        pending.reject(new Error(data.error || 'Module confirm failed'));
    }
};

function generateModuleName(type, addr, existingModules) {
    const displayName = MODULE_DISPLAY_NAMES[type] || type;
    const sameType = existingModules.filter(m => m.type === type);
    const addrNum = addr !== undefined ? addr : 0;

    // If there are already modules of this type, or addr > 1, use numbered name
    if (sameType.length > 0 || addrNum > 1) {
        const paddedAddr = String(addrNum).padStart(2, '0');
        return `${displayName} ${paddedAddr}`;
    }

    return displayName;
}
