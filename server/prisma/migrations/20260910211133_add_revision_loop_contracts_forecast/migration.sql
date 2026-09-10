-- AlterEnum
ALTER TYPE "AgentType" ADD VALUE 'CONTRACT';

-- AlterTable
ALTER TABLE "Deliverable" ADD COLUMN     "needsRevision" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "qaFeedback" TEXT,
ADD COLUMN     "revisionNotes" TEXT;

-- AlterTable
ALTER TABLE "Job" ADD COLUMN     "contractSentAt" TIMESTAMP(3);
