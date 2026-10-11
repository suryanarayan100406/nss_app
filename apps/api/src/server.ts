import 'dotenv/config';
import { config } from './config.js';
import { logger } from './logger.js';
import { disconnectDb } from './db.js';
import { app } from './app.js';

const server = app.listen(config.PORT, () => logger.info({ port: config.PORT }, 'NSS API listening'));

async function shutdown(signal: string) {
  logger.info({ signal }, 'shutting down');
  server.close(async () => { await disconnectDb(); process.exit(0); });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));
