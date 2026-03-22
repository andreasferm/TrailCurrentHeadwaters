const express = require('express');
const mqttService = require('../mqtt');

module.exports = (db) => {
    const router = express.Router();

    // POST /api/plateau/save-calibration — tell Plateau to save BNO055 offsets
    router.post('/save-calibration', (req, res) => {
        try {
            const success = mqttService.publishPlateauCalibrationSave();

            if (!success) {
                return res.status(503).json({
                    error: 'MQTT service not connected. Please try again later.'
                });
            }

            res.json({ success: true, message: 'Calibration save command sent' });
        } catch (error) {
            console.error('Error sending calibration save:', error);
            res.status(500).json({ error: 'Failed to send calibration save command' });
        }
    });

    return router;
};
