import pg from 'pg';
import { config } from '../src/config.js';

const { Client } = pg;
const databaseName = 'printready';
const databaseUrl = new URL(config.DATABASE_URL);

function isPlaceholder(value) {
  return typeof value === 'string' && /^<[^>]+>$/.test(value);
}

function fail(message, error) {
  const code = error?.code ? ` (${error.code})` : '';
  console.error(`[db:setup] ${message}${code}`);
  process.exit(1);
}

if (config.NODE_ENV !== 'development') {
  fail('Automatic database initialization is development-only.');
}
if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(databaseUrl.hostname)) {
  fail('Refusing automatic database initialization: DATABASE_URL must point to localhost.');
}
if (decodeURIComponent(databaseUrl.pathname.replace(/^\//, '')) !== databaseName) {
  fail(`Refusing automatic database initialization: DATABASE_URL must target the ${databaseName} database.`);
}
if (isPlaceholder(decodeURIComponent(databaseUrl.username)) || isPlaceholder(decodeURIComponent(databaseUrl.password)) || decodeURIComponent(databaseUrl.password) === 'YOUR_PASSWORD') {
  fail('DATABASE_URL still contains example credential placeholders. Set your local PostgreSQL username and password in .env.');
}
if (isPlaceholder(config.JWT_SECRET)) {
  fail('JWT_SECRET still contains an example placeholder. Set a secure local secret in .env.');
}

const adminUrl = new URL(config.DATABASE_URL);
adminUrl.pathname = '/postgres';
let admin;
try {
  admin = new Client({ connectionString: adminUrl.toString(), connectionTimeoutMillis: 5000 });
  await admin.connect();
  const found = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [databaseName]);
  if (found.rowCount === 0) {
    try {
      // The identifier is a fixed, validated application constant. PostgreSQL parameters cannot bind identifiers.
      await admin.query('CREATE DATABASE "printready"');
      console.log('[db:setup] Created local database printready.');
    } catch (error) {
      if (error.code !== '42P04') throw error;
      console.log('[db:setup] Database printready was created by another process.');
    }
  } else {
    console.log('[db:setup] Database printready already exists; leaving it unchanged.');
  }
} catch (error) {
  if (error.code === '28P01' || error.code === '28000') fail('PostgreSQL rejected the configured credentials. Check DATABASE_URL in .env.', error);
  if (error.code === '42501') fail('The configured PostgreSQL role cannot inspect or create databases.', error);
  if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT') fail('Could not connect to PostgreSQL at the configured local host and port. Verify the PostgreSQL service is running.', error);
  fail('Could not initialize the local database. Check PostgreSQL availability and role permissions.', error);
} finally {
  await admin?.end().catch(() => {});
}

let target;
try {
  target = new Client({ connectionString: config.DATABASE_URL, connectionTimeoutMillis: 5000 });
  await target.connect();
  const current = await target.query('SELECT current_database() AS name');
  if (current.rows[0]?.name !== databaseName) fail('Connected database name does not match printready.');

  const migrationTable = await target.query("SELECT to_regclass('public._prisma_migrations') AS name");
  const userTables = await target.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name <> '_prisma_migrations'");
  const migrationHistory = migrationTable.rows[0]?.name
    ? await target.query('SELECT count(*)::int AS count FROM public._prisma_migrations')
    : { rows: [{ count: 0 }] };
  if (migrationHistory.rows[0].count === 0 && userTables.rowCount > 0) {
    fail(`Database printready contains ${userTables.rowCount} table(s) but no Prisma migration history. Stop for manual review/baselining; no migrations were applied.`);
  }
  console.log('[db:setup] Connected to printready; existing data and migration history are preserved.');
} catch (error) {
  if (error.code === '28P01' || error.code === '28000') fail('PostgreSQL rejected the configured credentials for printready. Check DATABASE_URL in .env.', error);
  if (error.code === '3D000') fail('Database printready does not exist and could not be created; check CREATEDB permission.', error);
  if (error.code === '42501') fail('The configured PostgreSQL role lacks permission to inspect the printready schema.', error);
  if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT') fail('Could not connect to the printready database.', error);
  if (error?.message?.startsWith('Database printready contains')) fail(error.message);
  fail('Could not verify the printready database safely.', error);
} finally {
  await target?.end().catch(() => {});
}
