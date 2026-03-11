const logger = require('../utils/logger');

async function loadAuthState(folder = 'auth_info') {
    const { useMultiFileAuthState } = await import('../../lib/index.js');
    logger.info('Loading auth state...');
    const { state, saveCreds } = await useMultiFileAuthState(folder);
    logger.info('Auth state loaded!');
    return { state, saveCreds };
}

module.exports = { loadAuthState };
