import express from 'express';
import logger from './logger.js';

export function startKeepAlive(port = 3000) {
    const app = express();

    app.get('/', (_req, res) => res.send('🐺 SilentWolf is alive and hunting!'));
    app.get('/status', (_req, res) => res.json({
        status: 'online',
        name: 'SilentWolf',
        version: '1.0.0',
        uptime: process.uptime()
    }));

    app.listen(port, () => logger.info(`🌐 Keep-alive server running on port ${port}`));
}
