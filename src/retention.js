import { prisma } from './db.js';
import { deleteFile } from './storage.js';
import { config } from './config.js';

export async function cleanupExpiredDocuments({ batchSize = 100, logger = console } = {}) {
  const now = new Date();
  const terminalRetentionCutoff = new Date(now.getTime() - config.FILE_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const expired = await prisma.documentFile.findMany({
    where: { expiresAt: { lte: new Date() }, items: { none: {} } },
    orderBy: { expiresAt: 'asc' },
    take: batchSize,
    select: { id: true, storageKey: true },
  });
  let removed = 0;
  for (const file of expired) {
    try {
      await deleteFile(file.storageKey);
      const result = await prisma.documentFile.deleteMany({ where: { id: file.id, expiresAt: { lte: new Date() }, items: { none: {} } } });
      removed += result.count;
    } catch (error) {
      logger.warn?.({ code: error.code, fileId: file.id }, 'Expired document cleanup failed');
    }
  }
  const completedOrderFiles = await prisma.documentFile.findMany({
    where: {
      expiresAt: { lte: terminalRetentionCutoff },
      scanStatus: { in: ['AVAILABLE', 'QUARANTINED', 'REJECTED'] },
      items: {
        some: {},
        every: { order: { orderStatus: { in: ['COMPLETED', 'REJECTED', 'CANCELLED', 'REFUNDED'] }, updatedAt: { lte: terminalRetentionCutoff } } },
      },
    },
    orderBy: { expiresAt: 'asc' },
    take: batchSize,
    select: { id: true, storageKey: true },
  });
  let archived = 0;
  for (const file of completedOrderFiles) {
    try {
      await deleteFile(file.storageKey);
      const result = await prisma.documentFile.updateMany({
        where: { id: file.id, expiresAt: { lte: terminalRetentionCutoff }, scanStatus: { in: ['AVAILABLE', 'QUARANTINED', 'REJECTED'] } },
        data: { scanStatus: 'EXPIRED' },
      });
      archived += result.count;
    } catch (error) {
      logger.warn?.({ code: error.code, fileId: file.id }, 'Completed document retention cleanup failed');
    }
  }
  return { inspected: expired.length + completedOrderFiles.length, removed, archived };
}
