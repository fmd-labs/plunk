-- AlterTable
ALTER TABLE "campaigns" ADD COLUMN     "fork_created_by_key_id" TEXT,
ADD COLUMN     "fork_updated_by_key_id" TEXT;

-- AlterTable
ALTER TABLE "segments" ADD COLUMN     "fork_created_by_key_id" TEXT,
ADD COLUMN     "fork_updated_by_key_id" TEXT;

-- AlterTable
ALTER TABLE "templates" ADD COLUMN     "fork_created_by_key_id" TEXT,
ADD COLUMN     "fork_updated_by_key_id" TEXT;

-- CreateTable
CREATE TABLE "fork_api_keys" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "secretHash" TEXT NOT NULL,
    "scopes" TEXT[],
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "projectId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fork_api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "fork_api_keys_secretHash_key" ON "fork_api_keys"("secretHash");

-- CreateIndex
CREATE INDEX "fork_api_keys_projectId_idx" ON "fork_api_keys"("projectId");

-- AddForeignKey
ALTER TABLE "fork_api_keys" ADD CONSTRAINT "fork_api_keys_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
