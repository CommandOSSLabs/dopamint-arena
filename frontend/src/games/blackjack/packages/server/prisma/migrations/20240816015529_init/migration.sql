-- CreateTable
CREATE TABLE "GameActionData" (
    "id" TEXT NOT NULL,
    "gameId" TEXT NOT NULL,
    "playerBalance" INTEGER NOT NULL,
    "dealerBalance" INTEGER NOT NULL,
    "randomnessSeed" TEXT NOT NULL,
    "betAmount" INTEGER NOT NULL,
    "round" INTEGER NOT NULL,
    "step" INTEGER NOT NULL,
    "action" INTEGER NOT NULL,
    "playerHand" JSONB NOT NULL,
    "dealerHand" JSONB NOT NULL,
    "deck" JSONB NOT NULL,
    "playerSignature" TEXT NOT NULL,
    "dealerSignature" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GameActionData_pkey" PRIMARY KEY ("id")
);
