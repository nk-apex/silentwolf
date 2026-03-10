const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

const SESSION_PREFIX = 'SILENTWOLF_';
const CREDS_FILE = 'creds.json';

async function exportSession(authFolder) {
    const credsPath = path.join(authFolder, CREDS_FILE);

    if (!fs.existsSync(credsPath)) {
        throw new Error('No credentials found to export.');
    }

    const raw = fs.readFileSync(credsPath, 'utf-8');
    const encoded = Buffer.from(raw, 'utf-8').toString('base64');
    const sessionId = `${SESSION_PREFIX}${encoded}`;

    logger.info('📦 Session exported');
    return sessionId;
}

async function importSession(sessionId, authFolder) {
    if (!sessionId || !sessionId.startsWith(SESSION_PREFIX)) {
        throw new Error('Invalid SilentWolf session ID');
    }

    const encoded = sessionId.slice(SESSION_PREFIX.length);

    let raw;
    try {
        raw = Buffer.from(encoded, 'base64').toString('utf-8');
        JSON.parse(raw); // Validate it's proper JSON
    } catch {
        throw new Error('Invalid SilentWolf session ID');
    }

    if (!fs.existsSync(authFolder)) {
        fs.mkdirSync(authFolder, { recursive: true });
    }

    const credsPath = path.join(authFolder, CREDS_FILE);
    fs.writeFileSync(credsPath, raw, 'utf-8');

    logger.info('📥 Session imported successfully');
}

async function isSessionValid(authFolder) {
    const credsPath = path.join(authFolder, CREDS_FILE);

    if (!fs.existsSync(credsPath)) {
        logger.warn('❌ No session found');
        return false;
    }

    try {
        const raw = fs.readFileSync(credsPath, 'utf-8');
        const parsed = JSON.parse(raw);

        if (!parsed || typeof parsed !== 'object') {
            logger.warn('❌ No session found');
            return false;
        }

        logger.info('✅ Valid session found');
        return true;
    } catch {
        logger.warn('❌ No session found');
        return false;
    }
}

module.exports = { exportSession, importSession, isSessionValid };
