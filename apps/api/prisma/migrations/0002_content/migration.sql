ALTER TABLE "Event" ADD COLUMN "legacyPath" TEXT, ADD COLUMN "dateLabel" TEXT, ADD COLUMN "dateOnly" BOOLEAN NOT NULL DEFAULT false, ADD COLUMN "draft" JSONB, ADD COLUMN "deletedAt" TIMESTAMP(3), ADD COLUMN "galleryReleaseAt" TIMESTAMP(3), ADD COLUMN "registrationOpensAt" TIMESTAMP(3), ADD COLUMN "registrationClosesAt" TIMESTAMP(3);
CREATE UNIQUE INDEX "Event_legacyPath_key" ON "Event"("legacyPath");
ALTER TABLE "TeamMember" ADD COLUMN "sourceKey" TEXT;
CREATE UNIQUE INDEX "TeamMember_sourceKey_key" ON "TeamMember"("sourceKey");
