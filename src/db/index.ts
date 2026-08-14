import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema'

const url = process.env.DATABASE_URL
if (!url) throw new Error('DATABASE_URL is not set (see .env.example)')

// On a serverless host every invocation is its own isolate, so a large pool per
// instance just exhausts the database's connection limit. Use a pooled
// connection string (Neon's -pooler host, Supabase's :6543) in that case.
const serverless = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME)

const globalForDb = globalThis as unknown as { __sql?: ReturnType<typeof postgres> }
const sql =
  globalForDb.__sql ??
  postgres(url, {
    max: serverless ? 1 : 10,
    idle_timeout: serverless ? 20 : undefined,
    // Transaction-pooling proxies (pgbouncer, Neon pooler) reject prepared
    // statements, and every hosted Postgres requires TLS.
    prepare: !serverless,
    ssl: url.includes('localhost') || url.includes('127.0.0.1') ? undefined : 'require',
  })

if (process.env.NODE_ENV !== 'production') globalForDb.__sql = sql

export const db = drizzle(sql, { schema })
export { sql, schema }
