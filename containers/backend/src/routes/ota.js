const express = require('express');
const fs = require('fs');
const path = require('path');
const mqttService = require('../mqtt');

const FIRMWARE_DIR = '/app/firmware';
const OTA_WAIT_MS = 5000; // Wait for module to start HTTP server after CAN trigger

module.exports = () => {
    const router = express.Router();
    // POST /api/ota/trigger - Trigger OTA update for a device
    // Sends CAN 0x00, waits for module to start HTTP server, then POSTs firmware
    router.post('/trigger', async (req, res) => {
        try {
            const { hostname, firmware_file } = req.body;

            // Validate hostname format: esp32-XXXXXX where X are hex digits
            const hostnameRegex = /^esp32-([0-9A-Fa-f]{6})$/;
            const match = hostname.match(hostnameRegex);

            if (!match) {
                return res.status(400).json({
                    error: 'Invalid hostname format. Expected format: esp32-XXYYZZ (where XX, YY, ZZ are hex digits)'
                });
            }

            if (!firmware_file || typeof firmware_file !== 'string') {
                return res.status(400).json({ error: 'firmware_file is required' });
            }

            // Validate firmware file exists
            const firmwarePath = path.join(FIRMWARE_DIR, path.basename(firmware_file));
            if (!fs.existsSync(firmwarePath)) {
                return res.status(404).json({ error: `Firmware file not found: ${firmware_file}` });
            }

            // Extract MAC bytes for CAN trigger
            const macHex = match[1];
            const macBytes = [];
            for (let i = 0; i < 6; i += 2) {
                macBytes.push(parseInt(macHex.substring(i, i + 2), 16));
            }

            // Send CAN 0x00 OTA trigger
            const canData = [macBytes[0], macBytes[1], macBytes[2], 0x00, 0x00, 0x00, 0x00, 0x00];
            const canSuccess = mqttService.publishCanMessage(0x0, canData);

            if (!canSuccess) {
                return res.status(503).json({ error: 'MQTT service not connected' });
            }

            // Respond immediately — firmware upload happens async
            res.json({
                success: true,
                message: 'OTA triggered, firmware upload starting',
                hostname: hostname,
                firmware_file: firmware_file
            });

            // Broadcast OTA start to WebSocket clients
            const broadcast = req.app.get('broadcast');
            if (broadcast) {
                broadcast('ota_progress', { hostname, status: 'triggered', message: 'CAN trigger sent, waiting for module...' });
            }

            // Wait for module to enter OTA mode and start HTTP server
            await new Promise(resolve => setTimeout(resolve, OTA_WAIT_MS));

            // POST firmware binary to module
            try {
                if (broadcast) {
                    broadcast('ota_progress', { hostname, status: 'uploading', message: 'Uploading firmware...' });
                }

                const firmwareData = fs.readFileSync(firmwarePath);
                const response = await fetch(`http://${hostname}.local/ota`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/octet-stream' },
                    body: firmwareData,
                    signal: AbortSignal.timeout(180000) // 3-minute timeout matches firmware
                });

                if (response.ok) {
                    const text = await response.text();
                    console.log(`[OTA] Firmware uploaded to ${hostname}: ${text}`);

                    if (broadcast) {
                        broadcast('ota_progress', { hostname, status: 'complete', message: 'Firmware uploaded, module rebooting' });
                    }
                } else {
                    const errText = await response.text();
                    console.error(`[OTA] Upload failed for ${hostname}: ${response.status} ${errText}`);
                    if (broadcast) {
                        broadcast('ota_progress', { hostname, status: 'error', message: `Upload failed: ${response.status}` });
                    }
                }
            } catch (uploadErr) {
                console.error(`[OTA] Upload error for ${hostname}:`, uploadErr.message);
                if (broadcast) {
                    broadcast('ota_progress', { hostname, status: 'error', message: uploadErr.message });
                }
            }
        } catch (error) {
            console.error('Error triggering OTA:', error);
            res.status(500).json({ error: 'Failed to trigger OTA update' });
        }
    });

    // GET /api/ota/firmware - List available firmware files
    router.get('/firmware', (req, res) => {
        try {
            if (!fs.existsSync(FIRMWARE_DIR)) {
                return res.json([]);
            }

            const files = fs.readdirSync(FIRMWARE_DIR)
                .filter(f => f.endsWith('.bin'))
                .map(f => {
                    const stats = fs.statSync(path.join(FIRMWARE_DIR, f));
                    return {
                        filename: f,
                        size: stats.size,
                        modified: stats.mtime.toISOString()
                    };
                })
                .sort((a, b) => new Date(b.modified) - new Date(a.modified));

            res.json(files);
        } catch (error) {
            console.error('Error listing firmware:', error);
            res.status(500).json({ error: 'Failed to list firmware files' });
        }
    });

    // POST /api/ota/upload-firmware - Upload a firmware .bin file
    router.post('/upload-firmware', express.raw({ type: 'application/octet-stream', limit: '4mb' }), (req, res) => {
        try {
            const filename = req.headers['x-firmware-filename'];
            if (!filename || !filename.endsWith('.bin')) {
                return res.status(400).json({ error: 'X-Firmware-Filename header required (must end in .bin)' });
            }

            // Sanitize filename
            const safeName = path.basename(filename);

            // Ensure firmware directory exists
            if (!fs.existsSync(FIRMWARE_DIR)) {
                fs.mkdirSync(FIRMWARE_DIR, { recursive: true });
            }

            const filePath = path.join(FIRMWARE_DIR, safeName);
            fs.writeFileSync(filePath, req.body);

            console.log(`[OTA] Firmware uploaded: ${safeName} (${req.body.length} bytes)`);
            res.json({
                success: true,
                filename: safeName,
                size: req.body.length
            });
        } catch (error) {
            console.error('Error uploading firmware:', error);
            res.status(500).json({ error: 'Failed to upload firmware' });
        }
    });

    return router;
};
