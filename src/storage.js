import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  CopyObjectCommand, DeleteObjectCommand, GetObjectCommand, HeadBucketCommand,
  PutObjectCommand, S3Client,
} from '@aws-sdk/client-s3';
import { config } from './config.js';
import { scanBuffer } from './antivirus.js';

const root = path.resolve(config.LOCAL_STORAGE_DIR);
export const storageMode = config.STORAGE_DRIVER;
const client = storageMode === 'r2' ? new S3Client({
  region: 'auto',
  endpoint: config.R2_ENDPOINT ?? `https://${config.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  forcePathStyle: true,
  credentials: { accessKeyId: config.R2_ACCESS_KEY_ID, secretAccessKey: config.R2_SECRET_ACCESS_KEY },
  maxAttempts: 2,
}) : null;
const bucket = config.R2_BUCKET;

function validKey(key, extensions) {
  if (typeof key !== 'string' || key.length > 512 || key.includes('..') || key.startsWith('/')) return false;
  const segments = key.split('/');
  return segments.length <= 2 && segments.every(segment => /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9]+)?$/.test(segment)) && extensions.test(key);
}

function localPath(key) {
  const resolved = path.resolve(root, ...key.split('/'));
  if (!resolved.startsWith(`${root}${path.sep}`)) throw new Error('Invalid storage key');
  return resolved;
}

async function putObject(key, bytes, contentType) {
  if (client) {
    await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: bytes, ContentType: contentType }));
    return;
  }
  const target = localPath(key);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, bytes, { flag: 'wx', mode: 0o600 });
}

export function createQuarantineKey() { return `quarantine/${randomUUID()}.pdf`; }

export async function putFile(bytes, key = createQuarantineKey()) {
  if (!key.startsWith('quarantine/') || !validKey(key, /^quarantine\/[\w-]+\.pdf$/)) throw new Error('Invalid quarantine key');
  await putObject(key, bytes, 'application/pdf');
  return key;
}

export async function promoteFile(key) {
  if (!validKey(key, /^quarantine\/[\w-]+\.pdf$/)) throw new Error('Invalid quarantine key');
  const approvedKey = key.replace(/^quarantine\//, 'documents/');
  if (client) {
    const source = `${bucket}/${key.split('/').map(encodeURIComponent).join('/')}`;
    await client.send(new CopyObjectCommand({ Bucket: bucket, Key: approvedKey, CopySource: source, MetadataDirective: 'COPY' }));
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  } else {
    const from = localPath(key);
    const to = localPath(approvedKey);
    await mkdir(path.dirname(to), { recursive: true });
    await rename(from, to);
  }
  return approvedKey;
}

export async function getFile(key) {
  if (!validKey(key, /^(?:quarantine|documents)\/[\w-]+\.pdf$|^[\w-]+\.pdf$/)) throw new Error('Invalid storage key');
  if (client) {
    const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    return Buffer.from(await result.Body.transformToByteArray());
  }
  return readFile(localPath(key));
}

export async function deleteFile(key) {
  if (!validKey(key, /^(?:quarantine|documents)\/[\w-]+\.pdf$|^[\w-]+\.pdf$/)) return;
  if (client) await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  else await unlink(localPath(key)).catch(error => { if (error.code !== 'ENOENT') throw error; });
}

const privateImageExtensions = { 'image/png': 'png', 'image/jpeg': 'jpg' };
export async function putPrivateImage(bytes, contentType) {
  const extension = privateImageExtensions[contentType];
  if (!extension) throw new Error('Unsupported private image type');
  const verdict = await scanBuffer(bytes);
  if (!verdict.clean) throw new Error('Upload was rejected by malware scanning');
  const key = `private-images/${randomUUID()}.${extension}`;
  await putObject(key, bytes, contentType);
  return key;
}

export async function getPrivateImage(key) {
  if (!validKey(key, /^(?:private-images\/)?[\w-]+\.(?:png|jpg)$/)) throw new Error('Invalid private image key');
  if (client) {
    const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    return Buffer.from(await result.Body.transformToByteArray());
  }
  return readFile(localPath(key));
}

export async function deletePrivateImage(key) {
  if (!validKey(key, /^(?:private-images\/)?[\w-]+\.(?:png|jpg)$/)) return;
  if (client) await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  else await unlink(localPath(key)).catch(error => { if (error.code !== 'ENOENT') throw error; });
}

export async function checkStorage() {
  if (client) await client.send(new HeadBucketCommand({ Bucket: bucket }));
  else await mkdir(root, { recursive: true });
  return true;
}
