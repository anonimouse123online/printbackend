import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const envPath = '.env';
const examplePath = '.env.example';
if (!existsSync(envPath)) {
  if (!existsSync(examplePath)) {
    console.error('[env] .env and .env.example are both missing.');
    process.exit(1);
  }
  writeFileSync(envPath, readFileSync(examplePath));
}

let contents = readFileSync(envPath, 'utf8');
const example = existsSync(examplePath) ? readFileSync(examplePath, 'utf8') : '';
const existingKeys = new Set(contents.split(/\r?\n/).map(line => line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/)?.[1]).filter(Boolean));
const missingDefaults = example.split(/\r?\n/).filter(line => {
  const key = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/)?.[1];
  return key && !existingKeys.has(key);
});
if (missingDefaults.length) contents = `${contents.trimEnd()}\n${missingDefaults.join('\n')}\n`;

const databaseUrl = contents.match(/^\s*DATABASE_URL\s*=\s*(.*)\s*$/m)?.[1] ?? '';
if (databaseUrl.includes('<DB_USER>') || databaseUrl.includes('<DB_PASSWORD>')) {
  const exampleUrl = example.match(/^\s*DATABASE_URL\s*=\s*(.*)\s*$/m)?.[1];
  if (exampleUrl) contents = contents.replace(/^\s*DATABASE_URL\s*=.*$/m, `DATABASE_URL=${exampleUrl}`);
}

const currentSecret = contents.match(/^\s*JWT_SECRET\s*=\s*(.*)\s*$/m)?.[1]?.trim().replace(/^(["'])(.*)\1$/, '$2');
const secretMissing = !currentSecret || currentSecret.length < 32 || /^<[^>]+>$/.test(currentSecret);
if (secretMissing) {
  const secret = randomBytes(48).toString('base64url');
  if (/^\s*JWT_SECRET\s*=/m.test(contents)) contents = contents.replace(/^\s*JWT_SECRET\s*=.*$/m, `JWT_SECRET=${secret}`);
  else contents = `${contents.trimEnd()}\nJWT_SECRET=${secret}\n`;
}

writeFileSync(envPath, contents, { mode: 0o600 });
console.log(`[env] .env is ready${secretMissing ? '; generated a secure JWT_SECRET' : ''}.`);
