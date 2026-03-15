const express = require('express');
const router = express.Router();

module.exports = () => {
    // Water tank data is streamed via WebSocket from CAN bus (no DB storage).
    // Returns null state — frontend waits for WebSocket data.
    router.get('/', (req, res) => {
        res.json({
            fresh: null,
            grey: null,
            black: null,
        });
    });

    return router;
};
