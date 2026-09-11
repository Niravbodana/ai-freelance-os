-- CreateTable
CREATE TABLE "RejectionLog" (
    "id" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RejectionLog_pkey" PRIMARY KEY ("id")
);
