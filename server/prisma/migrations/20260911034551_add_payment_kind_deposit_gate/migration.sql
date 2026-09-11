-- Payment moves from "one per job" to "up to one DEPOSIT + one FINAL per
-- job" — see pipelineAgent.js's deposit gate for why. Existing rows all
-- become FINAL (their original meaning), and the single-column unique
-- constraint is replaced by a composite one.
CREATE TYPE "PaymentKind" AS ENUM ('DEPOSIT', 'FINAL');

ALTER TABLE "Payment" ADD COLUMN "kind" "PaymentKind" NOT NULL DEFAULT 'FINAL';

DROP INDEX "Payment_jobId_key";

CREATE UNIQUE INDEX "Payment_jobId_kind_key" ON "Payment"("jobId", "kind");
