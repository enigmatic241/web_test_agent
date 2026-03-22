import winston from 'winston';

const isProd = process.env.NODE_ENV === 'production';

/**
 * JSON logs in production; readable logs in development.
 */
export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL ?? 'info',
  format: isProd
    ? winston.format.json()
    : winston.format.combine(
        winston.format.colorize(),
        winston.format.timestamp(),
        winston.format.printf(
          (info) => `${info.timestamp} [${info.level}] ${info.message} ${info.meta ? JSON.stringify(info.meta) : ''}`
        )
      ),
  transports: [new winston.transports.Console()],
});

export interface AgentLogContext {
  agent: string;
  pageSlug?: string;
  runId?: string;
  duration_ms?: number;
}

/**
 * Structured log with required agent context fields.
 */
export function logAgent(
  level: 'debug' | 'info' | 'warn' | 'error',
  message: string,
  ctx: AgentLogContext,
  extra?: Record<string, unknown>
): void {
  logger.log(level, message, { ...ctx, ...extra });
}
