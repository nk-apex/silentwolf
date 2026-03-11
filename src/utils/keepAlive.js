const express = require('express');
const logger = require('./logger');

function startKeepAlive(port = 3000) {
    const app = express();

    app.get('/', (req, res) => {
        res.status(200).send('🐺 SilentWolf is alive and hunting!');
    });

    app.get('/status', (req, res) => {
        res.status(200).json({
            status: 'online',
            name: 'SilentWolf',
            version: '1.0.0',
            uptime: process.uptime()
        });
    });

    app.listen(port, () => {
        logger.info(`🌐 Keep-alive server running on port ${port}`);
    });
}

module.exports = { startKeepAlive };
