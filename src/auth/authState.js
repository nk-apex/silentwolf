const { useMultiFileAuthState } = require('@whiskeysockets/baileys');
const logger = require('../utils/logger');

async function loadAuthState() {
    logger.info("Loading auth state...");
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    logger.info("Auth state loaded!");
    
    return { state, saveCreds };
}

module.exports = {
    loadAuthState
};
