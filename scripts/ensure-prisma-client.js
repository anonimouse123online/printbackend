import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const schemaPath = resolve('prisma/schema.prisma');
const generatedSchemaPath = resolve('node_modules/.prisma/client/schema.prisma');
const generatedEntrypoint = resolve('node_modules/.prisma/client/index.js');
const generatedDirectory = resolve('node_modules/.prisma/client');
const hasGeneratedEngine = existsSync(generatedDirectory) && readdirSync(generatedDirectory).some(name => name.includes('query_engine') && name.endsWith('.node') || name.includes('query-engine') && name.endsWith('.exe'));
const normalizeSchema = content => content.split(/\r?\n/).map(line => line.trim().replace(/\s+/g, ' ')).filter(Boolean).join('\n');

if (existsSync(generatedSchemaPath) && existsSync(generatedEntrypoint) && hasGeneratedEngine &&
    normalizeSchema(readFileSync(schemaPath, 'utf8')) === normalizeSchema(readFileSync(generatedSchemaPath, 'utf8'))) {
  console.log('[db:generate] Prisma Client is already generated for the current schema.');
  process.exit(0);
}

try {
  execFileSync(process.execPath, [resolve('node_modules/prisma/build/index.js'), 'generate'], { stdio: 'inherit' });
} catch {
  console.error('[db:generate] Prisma Client generation failed. Check file permissions and retry npm run db:generate.');
  process.exit(1);
}
