import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { redact } from './redact.js';

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const LEVEL_WEIGHT: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LogRecord {
  time: string;
  level: LogLevel;
  scope: string;
  message: string;
  [key: string]: unknown;
}

export interface LoggerOptions {
  level: LogLevel;
  /** When set, each record is appended as one JSON line to `<dir>/agent.log`. */
  logDir?: string | undefined;
  /** Mirror records to stdout. Disabled in tests to keep output readable. */
  console?: boolean;
}

export interface Logger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
  child(scope: string): Logger;
}

function write(options: LoggerOptions, record: LogRecord): void {
  const line = JSON.stringify(record);
  if (options.console !== false) {
    const stream =
      record.level === 'error' || record.level === 'warn' ? process.stderr : process.stdout;
    stream.write(`${line}\n`);
  }
  if (options.logDir) {
    try {
      mkdirSync(options.logDir, { recursive: true });
      appendFileSync(join(options.logDir, 'agent.log'), `${line}\n`, 'utf8');
    } catch (cause) {
      // Losing a log line must never take down a request; report once to stderr.
      process.stderr.write(
        `${JSON.stringify({
          time: new Date().toISOString(),
          level: 'error',
          scope: 'logger',
          message: 'failed to append to log file',
          error: cause instanceof Error ? cause.message : String(cause),
        })}\n`,
      );
    }
  }
}

export function createLogger(options: LoggerOptions, scope = 'agent-server'): Logger {
  const threshold = LEVEL_WEIGHT[options.level];

  const log = (level: LogLevel, message: string, context?: Record<string, unknown>): void => {
    if (LEVEL_WEIGHT[level] < threshold) return;
    const safeContext = context ? (redact(context) as Record<string, unknown>) : {};
    write(options, { time: new Date().toISOString(), level, scope, message, ...safeContext });
  };

  return {
    debug: (message, context) => log('debug', message, context),
    info: (message, context) => log('info', message, context),
    warn: (message, context) => log('warn', message, context),
    error: (message, context) => log('error', message, context),
    child: (childScope) => createLogger(options, `${scope}:${childScope}`),
  };
}
