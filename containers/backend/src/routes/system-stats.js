const express = require('express');
const router = express.Router();
const { readSystemStats } = require('../services/system-stats');

module.exports = () => {
    router.get('/', (req, res) => {
        res.json(readSystemStats());
    });

    return router;
};
