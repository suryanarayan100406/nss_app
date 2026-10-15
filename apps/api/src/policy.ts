import type { EventStatus } from '@prisma/client';
export const visibleStatuses: EventStatus[] = ['PUBLISHED', 'ONGOING', 'COMPLETED', 'CANCELLED'];
export const publicEventWhere = { visibility: 'PUBLIC' as const, deletedAt: null, status: { in: visibleStatuses } };
export const publicEventDetailWhere = { ...publicEventWhere, status: { in: [...visibleStatuses, 'ARCHIVED' as const] } };
export function isPublicEvent(event: { status: EventStatus; visibility: string; deletedAt?: Date | null }) { return !event.deletedAt && event.visibility === 'PUBLIC' && visibleStatuses.includes(event.status); }
export function assignAcademicYear(date: Date, years: Array<{ id: string; startsOn: Date; endsOn: Date }>) { return years.find((year) => date >= year.startsOn && date <= year.endsOn)?.id ?? null; }
export function canReview(actor: { id: string; role: string }, contributorId: string) { return ['ADMIN', 'APPROVER'].includes(actor.role) && actor.id !== contributorId; }
