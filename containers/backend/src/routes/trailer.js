const express = require('express');
const router = express.Router();

module.exports = () => {
    // Level data is streamed via WebSocket from Plateau CAN bus (no DB storage).
    // This route exists only for API consistency — returns empty state.
    router.get('/level', (req, res) => {
        res.json({
            front_back: null,
            side_to_side: null,
            front_back_diff_mm: null,
            left_right_diff_mm: null,
        });
    });

    return router;
};
