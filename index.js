const logger = require('./src/utils/logger');
const { connectToWhatsApp } = require('./src/socket/connection');

logger.info("Starting SilentWolf...");
connectToWhatsApp();
