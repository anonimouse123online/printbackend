import { spawnSync } from 'node:child_process';

if (process.env.NODE_ENV === 'production') {
  const migration = spawnSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], { stdio: 'inherit', env: process.env });
  if (migration.error) throw migration.error;
  if (migration.status !== 0) process.exit(migration.status ?? 1);
}

await import('../src/server.js');
