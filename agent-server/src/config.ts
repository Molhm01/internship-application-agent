import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import {
  AGENT_SERVER_HOST,
  AGENT_SERVER_PORT,
  DEFAULT_OLLAMA_MODEL,
  DEFAULT_OLLAMA_URL,
} from '@internship-agent/shared';

const here = dirname(fileURLToPath(import.meta.url));
/** dist/ or src/ -> agent-server/ -> repo root */
const repoRoot = resolve(here, '..', '..');

function envString(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw !== undefined && raw.trim() !== '' ? raw.trim() : fallback;
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Environment variable ${name} must be a number, received "${raw}"`);
  }
  return parsed;
}

function resolveFromRoot(value: string): string {
  return isAbsolute(value) ? value : resolve(repoRoot, value);
}

const dataDir = resolveFromRoot(envString('AGENT_DATA_DIR', 'local-data'));

export interface AgentServerConfig {
  readonly host: string;
  readonly port: number;
  readonly ollamaUrl: string;
  readonly defaultModel: string;
  readonly dataDir: string;
  readonly databasePath: string;
  readonly logDir: string;
  /** Uploads and resumes may only be read from inside this directory. */
  readonly documentsDir: string;
  readonly tokenPath: string;
  readonly logLevel: 'debug' | 'info' | 'warn' | 'error';
  /** Allows non-extension origins (curl, tests, the docs examples). */
  readonly allowLocalOrigins: boolean;
}

export const config: AgentServerConfig = {
  // Hard-coded to loopback. Exposing this server on a routable interface would
  // hand any local network client the user's full profile and documents.
  host: AGENT_SERVER_HOST,
  port: envNumber('AGENT_PORT', AGENT_SERVER_PORT),
  ollamaUrl: envString('OLLAMA_URL', DEFAULT_OLLAMA_URL),
  defaultModel: envString('OLLAMA_MODEL', DEFAULT_OLLAMA_MODEL),
  dataDir,
  databasePath: envString('AGENT_DB_PATH', join(dataDir, 'agent.db')),
  logDir: join(dataDir, 'logs'),
  documentsDir: join(dataDir, 'documents'),
  tokenPath: join(dataDir, 'agent-token.txt'),
  logLevel: envString('AGENT_LOG_LEVEL', 'info') as AgentServerConfig['logLevel'],
  allowLocalOrigins: envString('AGENT_ALLOW_LOCAL_ORIGINS', 'true') === 'true',
};

export const SERVER_VERSION = '0.1.0';
export const CURRENT_MILESTONE = 'Milestone 4 — grounded local AI answer generation';
