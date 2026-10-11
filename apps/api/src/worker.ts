import 'dotenv/config';
import { prisma, disconnectDb } from './db.js';
import { logger } from './logger.js';
import { publishScheduledEvent } from './routes.js';
import { releasePhotos } from './publication.js';

const POLL_MS = Number(process.env.SCHEDULER_POLL_MS ?? 5000);
let stopping = false;

async function claimDueJob() {
  const candidate = await prisma.scheduledJob.findFirst({ where: { status: 'PENDING', runAt: { lte: new Date() } }, orderBy: { runAt: 'asc' } });
  if (!candidate) return null;
  const claimed = await prisma.scheduledJob.updateMany({ where: { id: candidate.id, status: 'PENDING' }, data: { status: 'RUNNING', lockedAt: new Date(), attempts: { increment: 1 } } });
  return claimed.count === 1 ? candidate : null;
}

async function recoverStaleJobs() {
  await prisma.scheduledJob.updateMany({ where: { status: 'RUNNING', lockedAt: { lt: new Date(Date.now() - 5 * 60 * 1000) } }, data: { status: 'PENDING', lockedAt: null } });
}

async function runJob() {
  const job = await claimDueJob();
  if (!job) return;
  try {
    if (job.type === 'EVENT_PUBLISH' && typeof (job.payload as { eventId?: unknown }).eventId === 'string') await publishScheduledEvent((job.payload as { eventId: string }).eventId);
    else if (job.type === 'GALLERY_RELEASE' && typeof (job.payload as { eventId?: unknown }).eventId === 'string') await releasePhotos((job.payload as { eventId: string }).eventId);
    else if (job.type === 'SITE_PUBLISH' && typeof (job.payload as { revisionId?: unknown }).revisionId === 'string') await prisma.$transaction(async (tx) => { const revisionId = (job.payload as { revisionId: string }).revisionId; const revision = await tx.siteRevision.findUniqueOrThrow({ where: { id: revisionId } }); await tx.siteRevision.updateMany({ where: { key: revision.key, status: 'PUBLISHED' }, data: { status: 'ARCHIVED' } }); await tx.siteRevision.update({ where: { id: revisionId }, data: { status: 'PUBLISHED', publishedAt: new Date(), scheduledAt: null } }); });
    else throw new Error(`Unsupported scheduled job type: ${job.type}`);
    await prisma.scheduledJob.update({ where: { id: job.id }, data: { status: 'SUCCEEDED', lockedAt: null, lastError: null } });
    logger.info({ jobId: job.id, type: job.type }, 'scheduled job completed');
  } catch (error) {
    const attempts = job.attempts + 1;
    const terminal = attempts >= 5;
    await prisma.scheduledJob.update({ where: { id: job.id }, data: { status: terminal ? 'FAILED' : 'PENDING', lockedAt: null, lastError: error instanceof Error ? error.message : String(error), runAt: terminal ? job.runAt : new Date(Date.now() + Math.min(60 * 60 * 1000, 2 ** attempts * 10_000)) } });
    logger.error({ err: error, jobId: job.id, attempts }, 'scheduled job failed');
  }
}

async function loop() {
  while (!stopping) { await recoverStaleJobs().catch((error) => logger.error({ err: error }, 'scheduler recovery failed')); await runJob().catch((error) => logger.error({ err: error }, 'scheduler polling failed')); await new Promise((resolve) => setTimeout(resolve, POLL_MS)); }
}

void loop();
async function shutdown() { stopping = true; await disconnectDb(); process.exit(0); }
process.once('SIGTERM', () => void shutdown());
process.once('SIGINT', () => void shutdown());
