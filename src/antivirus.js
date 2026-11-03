import net from 'node:net';
import { config } from './config.js';

const testScannerEnabled = config.NODE_ENV === 'test' || (config.NODE_ENV !== 'production' && process.env.VITEST === 'true');

function request(command, bytes, timeoutMs = config.CLAMAV_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: config.CLAMAV_HOST, port: config.CLAMAV_PORT });
    const reply = [];
    let settled = false;
    const failClosed = error => {
      if (settled) return;
      settled = true;
      socket.destroy();
      const failure = new Error('Malware scanning service is unavailable');
      failure.code = 'SCANNER_UNAVAILABLE';
      failure.cause = error;
      reject(failure);
    };
    socket.setTimeout(timeoutMs, () => failClosed(new Error('Scanner timed out')));
    socket.on('error', failClosed);
    socket.on('data', chunk => reply.push(chunk));
    socket.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(reply).toString('utf8').replaceAll('\0', '').trim());
    });
    socket.on('connect', () => {
      if (command === 'PING') {
        socket.end('zPING\0');
        return;
      }
      socket.write('zINSTREAM\0');
      for (let offset = 0; offset < bytes.length; offset += 64 * 1024) {
        const chunk = bytes.subarray(offset, Math.min(offset + 64 * 1024, bytes.length));
        const length = Buffer.allocUnsafe(4);
        length.writeUInt32BE(chunk.length);
        socket.write(length);
        socket.write(chunk);
      }
      socket.end(Buffer.alloc(4));
    });
  });
}

export function parseClamReply(reply) {
  if (/\bFOUND\b/.test(reply)) return { clean: false };
  if (/\bOK\b/.test(reply) && !/\bERROR\b/.test(reply)) return { clean: true, engine: 'clamav' };
  const error = new Error('Malware scanner returned an invalid response');
  error.code = 'SCANNER_UNAVAILABLE';
  throw error;
}

export async function scanBuffer(bytes) {
  if (testScannerEnabled) return { clean: true, engine: 'test-only' };
  return parseClamReply(await request('INSTREAM', bytes));
}

export async function checkMalwareScanner() {
  if (testScannerEnabled) return true;
  const reply = await request('PING', Buffer.alloc(0), Math.min(config.CLAMAV_TIMEOUT_MS, 2000));
  if (reply !== 'PONG') throw new Error('Malware scanner did not respond to PING');
  return true;
}
