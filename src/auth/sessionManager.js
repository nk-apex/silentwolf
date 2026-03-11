import fs from 'fs';
import path from 'path';
import logger from '../utils/logger.js';

const SESSION_PREFIX = 'SILENTWOLF_';
const CREDS_FILE = 'creds.json';

export async function exportSession(authFolder) {
    const credsPath = path.join(authFolder, CREDS_FILE);
    if (!fs.existsSync(credsPath)) throw new Error('No credentials found to export.');

    const raw = fs.readFileSync(credsPath, 'utf-8');
    const sessionId = `${SESSION_PREFIX}${Buffer.from(raw, 'utf-8').toString('base64')}`;
    logger.info('📦 Session exported');
    return sessionId;
}

export async function importSession(sessionId, authFolder) {
    if (!sessionId?.startsWith(SESSION_PREFIX)) throw new Error('Invalid SilentWolf session ID');

    let raw;
    try {
        raw = Buffer.from(sessionId.slice(SESSION_PREFIX.length), 'base64').toString('utf-8');
        JSON.parse(raw);
    } catch {
        throw new Error('Invalid SilentWolf session ID');
    }

    fs.mkdirSync(authFolder, { recursive: true });
    fs.writeFileSync(path.join(authFolder, CREDS_FILE), raw, 'utf-8');
    logger.info('📥 Session imported successfully');
}

export async function isSessionValid(authFolder) {
    const credsPath = path.join(authFolder, CREDS_FILE);
    if (!fs.existsSync(credsPath)) { logger.warn('❌ No session found'); return false; }

    try {
        const parsed = JSON.parse(fs.readFileSync(credsPath, 'utf-8'));
        if (!parsed || typeof parsed !== 'object') { logger.warn('❌ Invalid session data'); return false; }
        logger.info('✅ Valid session found');
        return true;
    } catch {
        logger.warn('❌ Corrupted session data');
        return false;
    }
}
