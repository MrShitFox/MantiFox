import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const rootDir = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

function requiredEnv(name) {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function parsePort(value) {
  const port = Number.parseInt(value || '3000', 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }
  return port;
}

function resolveDbPath(value) {
  const dbPath = value && value.trim() ? value.trim() : './data/app.sqlite';
  return path.isAbsolute(dbPath) ? dbPath : path.resolve(rootDir, dbPath);
}

export const config = Object.freeze({
  port: parsePort(process.env.PORT),
  adminPassword: requiredEnv('ADMIN_PASSWORD'),
  sessionSecret: requiredEnv('SESSION_SECRET'),
  appDbPath: resolveDbPath(process.env.APP_DB_PATH),
  sessionTtlMs: 1000 * 60 * 60 * 8,
  manticoreTimeoutMs: 10000
});
