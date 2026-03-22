import pg from 'pg';
import { z } from 'zod';

let pool: pg.Pool | null = null;

/**
 * True when DATABASE_URL or PG* env vars are present.
 */
export function hasDbConfig(): boolean {
  return !!(
    process.env.DATABASE_URL ||
    (process.env.PGHOST && process.env.PGUSER && process.env.PGDATABASE)
  );
}

const envSchema = z.object({
  DATABASE_URL: z.string().min(1).optional(),
  PGHOST: z.string().optional(),
  PGPORT: z.coerce.number().optional(),
  PGUSER: z.string().optional(),
  PGPASSWORD: z.string().optional(),
  PGDATABASE: z.string().optional(),
});

/**
 * Shared pg pool — never create per-request connections.
 */
export function getPool(): pg.Pool {
  if (pool) {
    return pool;
  }
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error('Invalid database environment');
  }
  const e = parsed.data;
  if (e.DATABASE_URL) {
    pool = new pg.Pool({ connectionString: e.DATABASE_URL, max: 10 });
  } else if (e.PGHOST && e.PGUSER && e.PGDATABASE) {
    pool = new pg.Pool({
      host: e.PGHOST,
      port: e.PGPORT ?? 5432,
      user: e.PGUSER,
      password: e.PGPASSWORD,
      database: e.PGDATABASE,
      max: 10,
    });
  } else {
    throw new Error('DATABASE_URL or PG* variables must be set for database access');
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
