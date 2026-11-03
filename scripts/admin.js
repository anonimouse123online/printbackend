import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { z } from 'zod';
import { config } from '../src/config.js';
import { prisma } from '../src/db.js';
import { hashPassword } from '../src/auth.js';
import { provisionInitialAdmin } from '../src/admin-provisioning.js';

function hiddenPrompt(label) {
  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') {
    throw new Error('Use an interactive terminal or set PRINTREADY_ADMIN_PASSWORD in the local environment.');
  }
  return new Promise((resolve, reject) => {
    let value = '';
    stdout.write(label);
    stdin.setRawMode(true);
    stdin.resume();
    const done = (error, result) => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdout.write('\n');
      error ? reject(error) : resolve(result);
    };
    const onData = buffer => {
      for (const char of buffer.toString('utf8')) {
        if (char === '\u0003') return done(new Error('Cancelled.'));
        if (char === '\r' || char === '\n') return done(null, value);
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else if (char >= ' ' && char !== '\u007f') value += char;
      }
    };
    stdin.on('data', onData);
  });
}

async function status() {
  const [admins, shops] = await Promise.all([
    prisma.user.findMany({ where: { role: 'ADMIN' }, select: { id: true, email: true, fullName: true } }),
    prisma.printingShop.findMany({ where: { shopName: { equals: 'sample printing', mode: 'insensitive' } }, include: { owner: { select: { fullName: true, email: true } }, services: true } }),
  ]);
  console.log(`[admin] PostgreSQL has ${admins.length} administrator account(s).`);
  for (const admin of admins) console.log(`[admin] Existing administrator: ${admin.fullName} <${admin.email}> (${admin.id}).`);
  if (!shops.length) console.log('[admin] No shop named "sample printing" was found.');
  for (const shop of shops) console.log(JSON.stringify({ shopName: shop.shopName, id: shop.id, owner: shop.owner, address: shop.address, city: shop.city, contactNumber: shop.contactNumber, verificationStatus: shop.verificationStatus, operatingStatus: shop.operatingStatus, registeredAt: shop.createdAt, services: shop.services.map(({ serviceName, serviceType, isAvailable }) => ({ serviceName, serviceType, isAvailable })) }));
}

async function provision() {
  if (config.NODE_ENV !== 'development') throw new Error('Initial admin provisioning is restricted to local development.');
  const url = new URL(config.DATABASE_URL);
  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname) || url.pathname !== '/printready') {
    throw new Error('Refusing admin provisioning: DATABASE_URL must target local printready.');
  }

  let email = process.env.PRINTREADY_ADMIN_EMAIL?.trim().toLowerCase();
  let password = process.env.PRINTREADY_ADMIN_PASSWORD;
  if (!email && stdin.isTTY) {
    const terminal = readline.createInterface({ input: stdin, output: stdout });
    email = (await terminal.question('Administrator email: ')).trim().toLowerCase();
    terminal.close();
  }
  if (!password) password = await hiddenPrompt('Administrator password (input hidden): ');
  email = z.string().email().parse(email);
  if (password.length < 16 || password.length > 128) throw new Error('Administrator password must be 16 to 128 characters.');
  delete process.env.PRINTREADY_ADMIN_PASSWORD;

  const passwordHash = await hashPassword(password);
  password = '';
  const user = await provisionInitialAdmin({ db: prisma, email, passwordHash });
  console.log(`[admin] Created the initial administrator account ${email} (${user.id}). Password and token were not logged.`);
}

try {
  if (process.argv.includes('--status')) await status();
  else await provision();
} catch (error) {
  console.error(`[admin] ${error.message}`);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
