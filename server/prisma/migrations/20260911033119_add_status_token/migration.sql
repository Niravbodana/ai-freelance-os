-- AlterTable: add statusToken as nullable first, backfill existing rows,
-- then enforce NOT NULL + UNIQUE. A straight `prisma migrate dev` can't do
-- this in one step against a table that already has rows (Prisma's
-- @default(uuid()) is applied client-side, not as a real Postgres DEFAULT).
ALTER TABLE "Job" ADD COLUMN "statusToken" TEXT;

UPDATE "Job" SET "statusToken" = gen_random_uuid()::text WHERE "statusToken" IS NULL;

ALTER TABLE "Job" ALTER COLUMN "statusToken" SET NOT NULL;

CREATE UNIQUE INDEX "Job_statusToken_key" ON "Job"("statusToken");
