const express = require('express');
const logger = require('./logger');

function startKeepAlive() {
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

    app.listen(3000, () => {
        logger.info('🌐 Keep-alive server running on port 3000');
    });
}

module.exports = { startKeepAlive };
