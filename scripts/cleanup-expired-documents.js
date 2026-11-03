import { prisma } from '../src/db.js';
import { cleanupExpiredDocuments } from '../src/retention.js';

try {
  const result = await cleanupExpiredDocuments();
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(`Document cleanup failed (${error.code ?? 'unknown'}).`);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
