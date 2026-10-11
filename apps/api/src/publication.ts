import { Prisma } from '@prisma/client';
import { prisma } from './db.js';
import { createPublicDerivative } from './media.js';
import { isPublicEvent } from './policy.js';
import { HttpError } from './errors.js';
import type { AuthUser } from './types.js';

export async function lockEvent(tx: Prisma.TransactionClient, id: string) { await tx.$queryRaw`SELECT id FROM "Event" WHERE id=${id} FOR UPDATE`; }

export async function releasePhotos(eventId: string) {
  const photos = await prisma.photoSubmission.findMany({ where: { eventId, status: 'APPROVED' }, include: { media: true, contributor: true } });
  for (const photo of photos) {
    const { publicKey } = await createPublicDerivative(photo.media.storageKey, `images/${photo.id}.webp`);
    await prisma.$transaction(async (tx) => {
      await lockEvent(tx, eventId);
      const event = await tx.event.findUniqueOrThrow({ where: { id: eventId } });
      if (!isPublicEvent(event)) return;
      const changed = await tx.photoSubmission.updateMany({ where: { id: photo.id, status: 'APPROVED' }, data: { status: 'PUBLISHED', publishedAt: new Date() } });
      if (!changed.count) return;
      await tx.mediaAsset.update({ where: { id: photo.mediaId }, data: { status: 'PUBLIC', publicKey } });
      await tx.eventGalleryItem.upsert({ where: { eventId_mediaId: { eventId, mediaId: photo.mediaId } }, update: { publishedAt: new Date() }, create: { eventId, mediaId: photo.mediaId, publishedAt: new Date(), altText: photo.media.altText || event.title, caption: photo.media.caption, credit: photo.creditRequested ? photo.contributor.displayName : '', displayOrder: 10000 } });
    });
  }
}

export async function decide(actor: AuthUser, id: string, action: 'approve' | 'reject', reason?: string) {
  if (action === 'reject' && !reason?.trim()) throw new HttpError(400, 'REJECTION_REASON_REQUIRED', 'A rejection reason is required.');
  const photo = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "PhotoSubmission" WHERE id=${id} FOR UPDATE`;
    const photo = await tx.photoSubmission.findUnique({ where: { id }, include: { event: true } });
    if (!photo) throw new HttpError(404, 'PHOTO_NOT_FOUND', 'Photo not found.');
    if (photo.contributorId === actor.id) throw new HttpError(403, 'SELF_APPROVAL_FORBIDDEN', 'Another reviewer must decide on your upload.');
    if (photo.status !== 'PENDING_REVIEW') throw new HttpError(409, 'INVALID_PHOTO_STATE', 'Another reviewer already decided this photo.');
    await tx.photoSubmission.update({ where: { id }, data: { status: action === 'approve' ? 'APPROVED' : 'REJECTED', rejectionReason: reason ?? null } });
    await tx.moderationDecision.create({ data: { submissionId: id, reviewerId: actor.id, decision: action === 'approve' ? 'APPROVED' : 'REJECTED', reason } });
    await tx.notification.create({ data: { userId: photo.contributorId, type: 'PHOTO_DECISION', title: `Photo ${action === 'approve' ? 'approved' : 'rejected'}`, body: `${photo.event.title}: ${reason || 'Thank you for contributing.'}`, link: '/manage/photos' } });
    await tx.auditLog.create({ data: { actorId: actor.id, action: `photo_${action}`, objectType: 'PhotoSubmission', objectId: id, metadata: { reason: reason ?? null } } });
    if (action === 'approve') await tx.scheduledJob.upsert({ where: { key: `gallery:${photo.eventId}` }, create: { key: `gallery:${photo.eventId}`, type: 'GALLERY_RELEASE', runAt: new Date(), payload: { eventId: photo.eventId } }, update: { status: 'PENDING', runAt: new Date(), attempts: 0 } });
    return photo;
  });
  if (action === 'approve' && isPublicEvent(photo.event)) await releasePhotos(photo.eventId);
  return prisma.photoSubmission.findUniqueOrThrow({ where: { id } });
}
