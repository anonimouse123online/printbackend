import pg from 'pg';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { Prisma } from '@prisma/client';
import { config } from '../src/config.js';

const expectedModels = Prisma.dmmf.datamodel.models.map(model => ({
  table: model.dbName ?? model.name,
  columns: model.fields.filter(field => field.kind === 'scalar' || field.kind === 'enum').map(field => field.dbName ?? field.name),
  foreignKeys: model.fields.filter(field => field.kind === 'object' && field.relationFromFields?.length).length,
}));
const expectedTables = expectedModels.map(model => model.table);
const migrationDirectory = resolve('prisma/migrations');
const client = new pg.Client({ connectionString: config.DATABASE_URL, connectionTimeoutMillis: 5000 });

try {
  await client.connect();
  const db = await client.query('SELECT current_database() AS name');
  const tables = await client.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'");
  const actual = new Set(tables.rows.map(row => row.table_name));
  const missing = expectedTables.filter(name => !actual.has(name));
  if (missing.length) throw new Error(`Missing migrated tables: ${missing.join(', ')}`);

  const columnResult = await client.query("SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public'");
  const columnsByTable = new Map();
  for (const row of columnResult.rows) {
    if (!columnsByTable.has(row.table_name)) columnsByTable.set(row.table_name, new Set());
    columnsByTable.get(row.table_name).add(row.column_name);
  }
  for (const model of expectedModels) {
    const actualColumns = columnsByTable.get(model.table) ?? new Set();
    const missingColumns = model.columns.filter(name => !actualColumns.has(name));
    const extraColumns = [...actualColumns].filter(name => !model.columns.includes(name));
    if (missingColumns.length || extraColumns.length) {
      throw new Error(`Schema drift in ${model.table}; missing columns: ${missingColumns.join(', ') || 'none'}; unexpected columns: ${extraColumns.join(', ') || 'none'}.`);
    }
  }

  const expectedEnums = new Map(Prisma.dmmf.datamodel.enums.map(def => [def.dbName ?? def.name, def.values.map(value => typeof value === 'string' ? value : value.dbName ?? value.name)]));
  const enumResult = await client.query(`SELECT t.typname AS enum_name,e.enumlabel AS enum_value
    FROM pg_type t JOIN pg_enum e ON t.oid=e.enumtypid JOIN pg_namespace n ON n.oid=t.typnamespace
    WHERE n.nspname='public' ORDER BY t.typname,e.enumsortorder`);
  const actualEnums = new Map();
  for (const row of enumResult.rows) {
    if (!actualEnums.has(row.enum_name)) actualEnums.set(row.enum_name, []);
    actualEnums.get(row.enum_name).push(row.enum_value);
  }
  for (const [name, values] of expectedEnums) {
    if (JSON.stringify(actualEnums.get(name) ?? []) !== JSON.stringify(values)) throw new Error(`Schema drift in enum ${name}.`);
  }
  for (const name of actualEnums.keys()) if (!expectedEnums.has(name)) throw new Error(`Unexpected PostgreSQL enum ${name} exists in public schema.`);

  const migrationRows = await client.query('SELECT migration_name,checksum,finished_at,rolled_back_at FROM public._prisma_migrations ORDER BY started_at');
  const migrationFolders = readdirSync(migrationDirectory, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name);
  const migrationNames = new Set(migrationFolders);
  const applied = new Set();
  for (const row of migrationRows.rows) {
    if (row.rolled_back_at) continue;
    if (!row.finished_at) throw new Error(`Prisma migration ${row.migration_name} is incomplete; manual review is required.`);
    if (!migrationNames.has(row.migration_name)) throw new Error(`Applied migration ${row.migration_name} is missing from prisma/migrations.`);
    const sqlPath = join(migrationDirectory, row.migration_name, 'migration.sql');
    if (!existsSync(sqlPath)) throw new Error(`Migration SQL is missing for ${row.migration_name}.`);
    const checksum = createHash('sha256').update(readFileSync(sqlPath)).digest('hex');
    if (checksum !== row.checksum) throw new Error(`Applied migration ${row.migration_name} was modified after application.`);
    applied.add(row.migration_name);
  }
  for (const name of migrationNames) if (!applied.has(name)) throw new Error(`Migration ${name} is not applied; run npm run db:migrate:deploy.`);

  const integrity = await client.query(`
    SELECT
      (SELECT count(*) FROM information_schema.table_constraints WHERE constraint_schema='public' AND constraint_type='PRIMARY KEY')::int AS primary_keys,
      (SELECT count(*) FROM information_schema.table_constraints WHERE constraint_schema='public' AND constraint_type='FOREIGN KEY')::int AS foreign_keys,
      (SELECT count(*) FROM pg_indexes WHERE schemaname='public')::int AS indexes,
      (SELECT count(*) FROM pg_indexes WHERE schemaname='public' AND indexdef LIKE 'CREATE UNIQUE INDEX%')::int AS unique_indexes,
      (SELECT count(*) FROM pg_type t JOIN pg_enum e ON t.oid=e.enumtypid JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public')::int AS enum_values,
      (SELECT count(*) FROM public._prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL)::int AS applied_migrations,
      (SELECT count(*) FROM public._prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL)::int AS incomplete_migrations
  `);
  const row = integrity.rows[0];
  if (row.incomplete_migrations > 0) throw new Error('Prisma has an incomplete migration; manual review is required.');
  if (row.applied_migrations < 1) throw new Error('No completed Prisma migrations were found.');
  const expectedForeignKeys = expectedModels.reduce((sum, model) => sum + model.foreignKeys, 0);
  if (row.foreign_keys !== expectedForeignKeys) throw new Error(`Schema drift: expected ${expectedForeignKeys} application foreign keys, found ${row.foreign_keys}.`);
  console.log(`[db:verify] ${db.rows[0].name}: verified ${expectedTables.length} application tables and columns, ${row.primary_keys} primary keys, ${row.foreign_keys} foreign keys, ${row.unique_indexes} unique indexes, ${row.indexes} indexes, ${row.enum_values} enum values, and ${row.applied_migrations} migration(s)/checksums.`);
} catch (error) {
  console.error(`[db:verify] ${error.code ? `(${error.code}) ` : ''}${error.message}`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
