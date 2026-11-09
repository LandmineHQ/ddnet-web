#!/usr/bin/env node
import fs from 'node:fs';
import { loadConfig, describeConfig, printableConfig, VERSION } from '../src/config.mjs';
import { createRelayServer } from '../src/server.mjs';
import { createLogger, serializeError } from '../src/log.mjs';

function usage() {
  return `ddnet-ws-relay v${VERSION}

Usage: node bin/relay.mjs [options]

Options:
  -c, --config <file>     JSON config file (default: RELAY_CONFIG env)
      --host <host>       Bind host (default 127.0.0.1)
      --port <port>       Bind port (default 8390)
      --log-level <level> debug | info | warn | error | silent
      --token <token>     Add an accepted token (repeatable)
      --allow-private     Allow private/loopback/link-local UDP targets
      --allowlist <entry> Allow a host, IP or CIDR (repeatable)
      --servers <file>    JSON file with the recommended server list
      --print-config      Print the effective config as JSON (no token values) and exit
  -h, --help              Show this help

Environment: RELAY_CONFIG, RELAY_HOST, RELAY_PORT, RELAY_TOKENS, RELAY_ORIGINS,
ALLOW_PRIVATE, RELAY_ALLOWLIST, MAX_CONNS_PER_IP, MAX_PACKETS_PER_SEC,
MAX_BYTES_PER_SEC, IDLE_TIMEOUT_MS, MAX_CONNECTION_MS, RELAY_LOG_LEVEL, ...
`;
}

export function parseArgs(argv) {
  const args = { configPath: undefined, overrides: {} };
  const tokens = [];
  const allowlist = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`Missing value for ${arg}`);
      return argv[i];
    };
    switch (arg) {
      case '-h':
      case '--help':
        args.help = true;
        break;
      case '-c':
      case '--config':
        args.configPath = next();
        break;
      case '--host':
        args.overrides.host = next();
        break;
      case '--port': {
        const port = Number(next());
        if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid --port value');
        args.overrides.port = port;
        break;
      }
      case '--log-level':
        args.overrides.logLevel = next();
        break;
      case '--token':
        tokens.push(next());
        break;
      case '--allow-private':
        args.overrides.security = { ...(args.overrides.security ?? {}), allowPrivate: true };
        break;
      case '--allowlist':
        allowlist.push(next());
        break;
      case '--servers': {
        const file = next();
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        args.overrides.servers = Array.isArray(data) ? data : data.servers;
        break;
      }
      case '--print-config':
        args.printConfig = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (tokens.length > 0) args.overrides.auth = { ...(args.overrides.auth ?? {}), tokens };
  if (allowlist.length > 0) {
    args.overrides.security = { ...(args.overrides.security ?? {}), allowlist };
  }
  return args;
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`Error: ${error.message}\n\n${usage()}`);
    process.exitCode = 2;
    return;
  }
  if (args.help) {
    process.stdout.write(usage());
    return;
  }

  let config;
  try {
    config = loadConfig({ configPath: args.configPath, overrides: args.overrides });
  } catch (error) {
    process.stderr.write(`Configuration error: ${error.message}\n`);
    process.exitCode = 2;
    return;
  }

  if (args.printConfig) {
    // Effective key config, useful for debugging; token values are never printed.
    process.stdout.write(JSON.stringify(printableConfig(config), null, 2) + '\n');
    return;
  }

  const logger = createLogger({ level: config.logLevel });
  const relay = createRelayServer(config, { logger });
  const address = await relay.listen();
  logger.info('relay_started', {
    url: `ws://${address.address}:${address.port}${config.udpPath}/<host>:<port>`,
    healthz: `http://${address.address}:${address.port}/healthz`,
    config: describeConfig(config),
  });

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutdown_signal', { signal });
    try {
      await relay.close();
      process.exit(0);
    } catch (error) {
      logger.error('shutdown_failed', { error: serializeError(error) });
      process.exit(1);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('uncaughtException', (error) => {
    logger.error('uncaught_exception', { error: serializeError(error) });
    void shutdown('uncaughtException');
  });
  process.on('unhandledRejection', (reason) => {
    logger.error('unhandled_rejection', { error: serializeError(reason) });
  });
}

await main();
