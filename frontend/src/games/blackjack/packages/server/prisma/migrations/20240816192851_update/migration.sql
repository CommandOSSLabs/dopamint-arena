/*
  Warnings:

  - You are about to drop the column `action` on the `GameActionData` table. All the data in the column will be lost.
  - You are about to drop the column `betAmount` on the `GameActionData` table. All the data in the column will be lost.
  - You are about to drop the column `dealerBalance` on the `GameActionData` table. All the data in the column will be lost.
  - You are about to drop the column `dealerHand` on the `GameActionData` table. All the data in the column will be lost.
  - You are about to drop the column `deck` on the `GameActionData` table. All the data in the column will be lost.
  - You are about to drop the column `playerBalance` on the `GameActionData` table. All the data in the column will be lost.
  - You are about to drop the column `playerHand` on the `GameActionData` table. All the data in the column will be lost.
  - You are about to drop the column `randomnessSeed` on the `GameActionData` table. All the data in the column will be lost.
  - Added the required column `hex` to the `GameActionData` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "GameActionData" DROP COLUMN "action",
DROP COLUMN "betAmount",
DROP COLUMN "dealerBalance",
DROP COLUMN "dealerHand",
DROP COLUMN "deck",
DROP COLUMN "playerBalance",
DROP COLUMN "playerHand",
DROP COLUMN "randomnessSeed",
ADD COLUMN     "hex" TEXT NOT NULL,
ALTER COLUMN "round" SET DATA TYPE BIGINT,
ALTER COLUMN "step" SET DATA TYPE BIGINT;

-- CreateIndex
CREATE INDEX "GameActionData_gameId_round_step_idx" ON "GameActionData"("gameId", "round", "step");
