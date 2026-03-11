import { useMultiFileAuthState } from '../../lib/index.js';
import logger from '../utils/logger.js';

export async function loadAuthState(folder = 'auth_info') {
    logger.info('Loading auth state...');
    const { state, saveCreds } = await useMultiFileAuthState(folder);
    logger.info('Auth state loaded!');
    return { state, saveCreds };
}
