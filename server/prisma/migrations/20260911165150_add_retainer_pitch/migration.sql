-- AlterEnum
ALTER TYPE "AgentType" ADD VALUE 'RETAINER';

-- AlterTable
ALTER TABLE "Client" ADD COLUMN     "retainerPitchedAt" TIMESTAMP(3);
