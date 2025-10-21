import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';

type DrizzleDb = ReturnType<typeof drizzle<typeof schema>>;

const globalForDb = globalThis as typeof globalThis & {
    pgPool?: Pool;
    drizzleDb?: DrizzleDb;
};

function createPool() {
    if (!process.env.DATABASE_URL) {
        throw new Error('DATABASE_URL is not set');
    }
    return new Pool({
        connectionString: process.env.DATABASE_URL
    });
}

export const pool = globalForDb.pgPool ?? createPool();
export const db = globalForDb.drizzleDb ?? drizzle(pool, { schema });

if (!globalForDb.pgPool) {
    globalForDb.pgPool = pool;
}

if (!globalForDb.drizzleDb) {
    globalForDb.drizzleDb = db;
}
