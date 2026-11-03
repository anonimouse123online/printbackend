import { spawn } from 'node:child_process';
import net from 'node:net';

const portProbe = net.createServer();
await new Promise((resolve, reject) => portProbe.listen(0, '127.0.0.1', resolve).once('error', reject));
const { port } = portProbe.address();
await new Promise(resolve => portProbe.close(resolve));

const env = {
  ...process.env,
  NODE_ENV: 'production',
  DEMO_MODE: 'true',
  DATABASE_URL: 'postgresql://demo:demo@database-unavailable.invalid:5432/printready',
  JWT_SECRET: 'production-demo-startup-check-secret-'.padEnd(64, 'x'),
  FRONTEND_URL: 'https://demo.example.com',
  TRUSTED_ORIGINS: 'https://demo.example.com',
  STORAGE_DRIVER: 'local',
  PORT: String(port),
};
for (const key of ['R2_ACCOUNT_ID', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_ENDPOINT']) delete env[key];

const child = spawn(process.execPath, ['--env-file-if-exists=.env', 'src/server.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let output = '';
const collect = chunk => { output += chunk.toString(); };
child.stdout.on('data', collect);
child.stderr.on('data', collect);
try {
  const deadline = Date.now() + 10000;
  while (!output.includes(`PrintReady API listening on port ${port}`)) {
    if (child.exitCode !== null) throw new Error(`Production demo process exited before listening: ${output}`);
    if (Date.now() > deadline) throw new Error(`Production demo process did not listen in time: ${output}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const response = await fetch(`http://127.0.0.1:${port}/api/v1/health`);
  if (!response.ok) throw new Error(`Health endpoint returned ${response.status}`);
  const unauthenticatedUpload = await fetch(`http://127.0.0.1:${port}/api/v1/files`, { method: 'POST' });
  if (unauthenticatedUpload.status !== 401) throw new Error(`Unauthenticated upload returned ${unauthenticatedUpload.status}, expected 401`);
  console.log('Production DEMO_MODE startup, PORT binding, health endpoint, and upload authentication passed.');
} finally {
  child.kill('SIGTERM');
  await new Promise(resolve => {
    if (child.exitCode !== null) return resolve();
    const timeout = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 3000);
    child.once('exit', () => { clearTimeout(timeout); resolve(); });
  });
}
