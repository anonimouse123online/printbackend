import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.string().default('development'),
  DEMO_MODE: z.enum(['true', 'false']).default('false').transform(value => value === 'true'),
  PORT: z.coerce.number().int().min(1).max(65535).default(5001),
  DATABASE_URL: z.string().min(1).refine(v => !v.includes('<DB_') && !v.includes('YOUR_PASSWORD'), { message: 'replace the database credential placeholders' }),
  JWT_SECRET: z.string().min(32).refine(v => !/^<[^>]+>$/.test(v) && v !== 'GENERATED_AUTOMATICALLY_BY_DB_SETUP', { message: 'replace the JWT secret placeholder' }),
  JWT_EXPIRES_IN: z.string().default('1h'),
  FRONTEND_URL: z.string().url().default('http://localhost:5173'),
  TRUSTED_ORIGINS: z.string().default('http://localhost:5173'),
  STORAGE_DRIVER: z.enum(['local', 'r2']).default('local'),
  LOCAL_STORAGE_DIR: z.string().default('./storage/private'),
  R2_ACCOUNT_ID: z.string().optional(),
  R2_BUCKET: z.string().optional(),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  R2_ENDPOINT: z.string().url().optional(),
  CLAMAV_HOST: z.string().default('127.0.0.1'),
  CLAMAV_PORT: z.coerce.number().int().min(1).max(65535).default(3310),
  CLAMAV_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).default(30000),
  MAX_UPLOAD_BYTES: z.coerce.number().int().min(1).max(104857600).default(10485760),
  MAX_CONCURRENT_PDF_VALIDATIONS: z.coerce.number().int().min(1).max(4).default(1),
  USER_STORAGE_QUOTA_BYTES: z.coerce.number().int().min(1).default(104857600),
  FILE_RETENTION_DAYS: z.coerce.number().int().min(1).default(7),
  STORAGE_CLEANUP_INTERVAL_MS: z.coerce.number().int().min(60000).default(3600000),
  PAYMENT_PROVIDER: z.string().default('development'),
  PAYMENT_WEBHOOK_SECRET: z.string().optional(),
  PAYMENT_BASE_URL: z.string().optional(),
  PAYMENT_API_KEY: z.string().optional(),
});

export const config = schema.parse(process.env);
export const trustedOrigins = config.TRUSTED_ORIGINS.split(',').map(value => value.trim()).filter(Boolean);

if (config.STORAGE_DRIVER === 'r2') {
  const missing = ['R2_ACCOUNT_ID', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'].filter(key => !config[key]?.trim());
  if (missing.length) throw new Error(`R2 storage configuration is incomplete: ${missing.join(', ')}`);
  const endpoint = config.R2_ENDPOINT ?? `https://${config.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  if (!endpoint.startsWith('https://')) throw new Error('R2_ENDPOINT must use HTTPS');
}

if (config.NODE_ENV === 'production') {
  const problems = [];
  let databaseHost = '';
  try { databaseHost = new URL(config.DATABASE_URL).hostname; } catch {}
  if (!databaseHost || ['localhost', '127.0.0.1', '::1'].includes(databaseHost)) problems.push('DATABASE_URL must point to the production PostgreSQL database');
  if (config.JWT_SECRET.length < 64) problems.push('JWT_SECRET must contain at least 64 characters');
  if (!config.DEMO_MODE) {
    if (config.STORAGE_DRIVER !== 'r2') problems.push('STORAGE_DRIVER must be r2; local storage is ephemeral');
    for (const key of ['R2_ACCOUNT_ID', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY']) {
      if (!config[key]?.trim()) problems.push(`${key} is required for private object storage`);
    }
    const endpoint = config.R2_ENDPOINT ?? (config.R2_ACCOUNT_ID ? `https://${config.R2_ACCOUNT_ID}.r2.cloudflarestorage.com` : '');
    if (!endpoint.startsWith('https://')) problems.push('R2_ENDPOINT must use HTTPS');
    if (!config.CLAMAV_HOST.endsWith('.internal')) problems.push('CLAMAV_HOST must resolve through Render private networking (.internal)');
  }
  if (!trustedOrigins.length || trustedOrigins.some(origin => {
    try { const parsed = new URL(origin); return parsed.origin !== origin || parsed.protocol !== 'https:'; }
    catch { return true; }
  })) problems.push('TRUSTED_ORIGINS must contain exact HTTPS origins');
  if (!trustedOrigins.includes(config.FRONTEND_URL)) problems.push('FRONTEND_URL must be included in TRUSTED_ORIGINS');
  if (problems.length) throw new Error(`Production configuration is incomplete: ${problems.join('; ')}`);
}
