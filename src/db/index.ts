import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema'

const url = process.env.DATABASE_URL
if (!url) throw new Error('DATABASE_URL is not set (see .env.example)')

// Next.js dev hot-reload would otherwise open a new pool on every edit.
const globalForDb = globalThis as unknown as { __sql?: ReturnType<typeof postgres> }
const sql = globalForDb.__sql ?? postgres(url, { max: 10 })
if (process.env.NODE_ENV !== 'production') globalForDb.__sql = sql

export const db = drizzle(sql, { schema })
export { sql, schema }
