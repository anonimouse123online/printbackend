import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { fileTypeFromBuffer } from 'file-type';
import { PDFDocument } from 'pdf-lib';
import { config } from '../src/config.js';
import { createQuarantineKey, putFile, promoteFile, deleteFile } from '../src/storage.js';
import { scanBuffer } from '../src/antivirus.js';

const migrationUrl = process.env.PRINTREADY_MIGRATION_DATABASE_URL;
if (!migrationUrl) throw new Error('PRINTREADY_MIGRATION_DATABASE_URL is required.');
const database = new URL(migrationUrl);
if (database.pathname !== '/printready' || !database.hostname.endsWith('.oregon-postgres.render.com') || database.searchParams.get('sslmode') !== 'require') {
  throw new Error('Document migration requires the Render printready external database URL with SSL required.');
}
if (config.STORAGE_DRIVER !== 'r2') throw new Error('Document migration requires configured R2 object storage.');

const prisma = new PrismaClient({ datasources: { db: { url: migrationUrl } } });
const localRoot = path.resolve(config.LOCAL_STORAGE_DIR);
const files = await prisma.documentFile.findMany({ where: { scanStatus: 'QUARANTINED' }, orderBy: { id: 'asc' } });
let migrated = 0;
let skipped = 0;
let failed = 0;

for (const file of files) {
  if (!/^[\w-]+\.pdf$/.test(file.storageKey)) { skipped++; continue; }
  const sourcePath = path.resolve(localRoot, file.storageKey);
  if (!sourcePath.startsWith(`${localRoot}${path.sep}`) || !existsSync(sourcePath)) { failed++; continue; }
  if (statSync(sourcePath).size !== file.fileSize || file.fileSize > config.MAX_UPLOAD_BYTES) { failed++; continue; }

  const bytes = readFileSync(sourcePath);
  let quarantineKey;
  let approvedKey;
  try {
    const type = await fileTypeFromBuffer(bytes);
    if (file.contentType !== 'application/pdf' || type?.mime !== 'application/pdf' || bytes.subarray(0, 5).toString() !== '%PDF-') throw new Error('FILE_TYPE_MISMATCH');
    quarantineKey = createQuarantineKey();
    await putFile(bytes, quarantineKey);
    const verdict = await scanBuffer(bytes);
    if (!verdict.clean) throw new Error('MALWARE_DETECTED');
    const pdf = await PDFDocument.load(bytes, { ignoreEncryption: false, updateMetadata: false });
    if (pdf.getPageCount() !== file.pageCount) throw new Error('PAGE_COUNT_MISMATCH');
    approvedKey = await promoteFile(quarantineKey);
    await prisma.documentFile.update({
      where: { id: file.id, scanStatus: 'QUARANTINED' },
      data: { storageKey: approvedKey, scanStatus: 'AVAILABLE', scannedAt: new Date() },
    });
    migrated++;
  } catch {
    failed++;
    await Promise.allSettled([...(quarantineKey ? [deleteFile(quarantineKey)] : []), ...(approvedKey ? [deleteFile(approvedKey)] : [])]);
  }
}

await prisma.$disconnect();
console.log(JSON.stringify({ inspected: files.length, migrated, skipped, failed }));
if (failed) process.exitCode = 1;
