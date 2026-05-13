// Playbill remote-control API.
//
// Thin REST surface over the MQTT command topics the Playbill controller
// listens on. The PWA hits these endpoints when the user taps Tune, Scan,
// Stop, etc. — each call publishes a single command to
//   local/playbill/<deviceId>/<feature>/command
// and returns immediately. Status comes back to the PWA via the existing
// WebSocket as `playbill_status` events broadcast by mqtt.js.
//
// Design notes:
//   • One generic command endpoint (`POST /:deviceId/:feature/command`)
//     keeps the surface small. Adding new Playbill features (livetv,
//     transport, sources) requires no backend change — the PWA just sends
//     a different `feature` segment and `action` string.
//   • A deviceId of `all` is reserved as the broadcast target; the
//     controller subscribes to it in addition to its own id.
//   • Discovery uses the cache the MQTT service maintains from retained
//     `system/status` topics. No request goes on the wire for a list call.

const express = require('express');
const router = express.Router();
const mqttService = require('../mqtt');

// Allow letters, digits, '-', '_'. The controller slugifies hostnames into
// this shape (see controller/src/index.js defaultDeviceId), and 'all' is the
// reserved broadcast target. Reject anything weirder so an upstream typo
// doesn't accidentally publish to a malformed topic.
const DEVICE_ID_RE  = /^[a-z0-9_-]{1,32}$/;
// Limit features to the small known set so a PWA bug can't publish on an
// arbitrary topic path. Add to this list as Playbill grows.
const KNOWN_FEATURES = new Set(['radio', 'transport', 'livetv', 'volume', 'system', 'nav', 'source', 'youtube']);

module.exports = () => {
    // GET /api/playbill/devices
    // Returns the cached list of known Playbills from their retained system
    // presence topic. Includes offline devices so the UI can still render
    // them as greyed-out (and so a refresh doesn't briefly hide a Playbill
    // that hasn't republished yet).
    router.get('/devices', (req, res) => {
        res.json({ devices: mqttService.listPlaybillDevices() });
    });

    // POST /api/playbill/:deviceId/:feature/command
    // Body: { action: 'radio.tune', value: { band: 'fm', frequencyHz: 97500000 }, ... }
    router.post('/:deviceId/:feature/command', (req, res) => {
        const { deviceId, feature } = req.params;
        const cmd = req.body || {};

        if (!DEVICE_ID_RE.test(deviceId)) {
            return res.status(400).json({ error: 'Invalid deviceId' });
        }
        if (!KNOWN_FEATURES.has(feature)) {
            return res.status(400).json({ error: `Unknown feature: ${feature}` });
        }
        if (typeof cmd.action !== 'string' || !cmd.action) {
            return res.status(400).json({ error: 'action (string) required in body' });
        }

        const ok = mqttService.publishPlaybillCommand(deviceId, feature, cmd);
        if (!ok) {
            return res.status(503).json({ error: 'MQTT not connected' });
        }
        res.json({ ok: true });
    });

    return router;
};
