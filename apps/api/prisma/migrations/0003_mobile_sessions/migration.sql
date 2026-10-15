-- Native Android sessions use rotating, hashed refresh tokens.
CREATE TABLE "MobileSession" (
    "id" TEXT NOT NULL,
    "familyId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "replacedByHash" TEXT,
    "lastUsedAt" TIMESTAMP(3),
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MobileSession_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MobileSession_tokenHash_key" ON "MobileSession"("tokenHash");
CREATE INDEX "MobileSession_userId_revokedAt_expiresAt_idx" ON "MobileSession"("userId", "revokedAt", "expiresAt");
CREATE INDEX "MobileSession_familyId_revokedAt_idx" ON "MobileSession"("familyId", "revokedAt");

ALTER TABLE "MobileSession" ADD CONSTRAINT "MobileSession_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
