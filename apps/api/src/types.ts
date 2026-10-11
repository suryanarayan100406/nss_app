import type { Role, User } from '@prisma/client';

export type AuthUser = Pick<User, 'id' | 'email' | 'displayName' | 'role' | 'emailVerifiedAt' | 'disabledAt'>;

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
      sessionId?: string;
    }
  }
}

export const roleRank: Record<Role, number> = { USER: 1, APPROVER: 2, ADMIN: 3 };
