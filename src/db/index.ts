import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import { getAppEnv } from '@/lib/env';
import * as schema from './schema';

const sql = neon(getAppEnv().databaseUrl);
export const db = drizzle(sql, { schema });
