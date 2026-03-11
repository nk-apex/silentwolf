const colors = {
    reset: "\x1b[0m",
    neonGreen: "\x1b[38;2;57;255;20m",
    brightCyan: "\x1b[96m",
    yellow: "\x1b[33m",
    red: "\x1b[31m",
    dimWhite: "\x1b[2m\x1b[37m"
};

const prefix = `${colors.neonGreen}🐺 SilentWolf${colors.reset}`;

function getTimestamp() {
    const now = new Date();
    return `${colors.dimWhite}[${now.toLocaleTimeString()}]${colors.reset}`;
}

const logger = {
    info:  (...args) => console.log(`${getTimestamp()} ${prefix}`, colors.neonGreen,  ...args, colors.reset),
    debug: (...args) => console.log(`${getTimestamp()} ${prefix}`, colors.brightCyan, ...args, colors.reset),
    warn:  (...args) => console.warn(`${getTimestamp()} ${prefix}`, colors.yellow,    ...args, colors.reset),
    error: (...args) => console.error(`${getTimestamp()} ${prefix}`, colors.red,      ...args, colors.reset),
};

export default logger;
