const LEVELS = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40, silent: 100 });

export function serializeError(error) {
  if (!error) return undefined;
  if (error instanceof Error) {
    return { name: error.name, message: error.message, code: error.code, stack: error.stack };
  }
  return { message: String(error) };
}

/**
 * Structured JSON logger: one JSON object per line, never multi-line.
 */
export function createLogger({ level = 'info', stream = process.stdout, now = () => new Date().toISOString(), base = {} } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;
  const logger = { level, base };
  const write = (lvl, event, fields = {}) => {
    if ((LEVELS[lvl] ?? 0) < threshold) return;
    const entry = { ts: now(), level: lvl, event, ...base };
    for (const [key, value] of Object.entries(fields ?? {})) {
      if (value !== undefined) entry[key] = value;
    }
    // Never let a circular object or a weird stream take down the relay.
    try {
      stream.write(JSON.stringify(entry) + '\n');
    } catch {
      /* ignore logging failures */
    }
  };
  for (const lvl of ['debug', 'info', 'warn', 'error']) {
    logger[lvl] = (event, fields) => write(lvl, event, fields);
  }
  logger.child = (bindings = {}) => createLogger({ level, stream, now, base: { ...base, ...bindings } });
  logger.isLevelEnabled = (lvl) => (LEVELS[lvl] ?? 0) >= threshold;
  return logger;
}
