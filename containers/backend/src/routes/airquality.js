const express = require('express');
const router = express.Router();

module.exports = () => {
    // Air quality data is streamed via WebSocket from CAN bus (no DB storage).
    // Returns null state — frontend waits for WebSocket data.
    router.get('/', (req, res) => {
        res.json({
            tvoc_ppb: null,
            eco2_ppm: null,
        });
    });

    return router;
};
