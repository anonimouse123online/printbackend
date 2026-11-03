import { Client } from 'pg';
import { spawnSync } from 'node:child_process';

const source = new URL(process.env.DATABASE_URL);
if (process.env.NODE_ENV !== 'development' || !['localhost', '127.0.0.1', '::1'].includes(source.hostname) || source.pathname !== '/printready') {
  throw new Error('Integration tests require the local development DATABASE_URL and use only the isolated printready_test database.');
}

const testUrl = new URL(source);
testUrl.pathname = '/printready_test';
const adminUrl = new URL(source);
adminUrl.pathname = '/postgres';
const client = new Client({ connectionString: adminUrl.toString() });
await client.connect();
try {
  const found = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', ['printready_test']);
  if (!found.rowCount) await client.query('CREATE DATABASE "printready_test"');
} finally {
  await client.end();
}

const env = { ...process.env, DATABASE_URL: testUrl.toString(), NODE_ENV: 'development' };
for (const args of [['node_modules/prisma/build/index.js', 'db', 'push', '--force-reset', '--accept-data-loss', '--skip-generate'], ['node_modules/vitest/vitest.mjs', 'run', 'tests/api.integration.test.js', '--pool=threads', '--maxWorkers=1']]) {
  const result = spawnSync(process.execPath, args, { stdio: 'inherit', env });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
