-- AlterTable
ALTER TABLE "users" ADD COLUMN     "fork_totp_enabled_at" TIMESTAMP(3),
ADD COLUMN     "fork_totp_secret" TEXT;

-- CreateTable
CREATE TABLE "fork_passkeys" (
    "id" TEXT NOT NULL,
    "credentialId" TEXT NOT NULL,
    "publicKey" BYTEA NOT NULL,
    "counter" BIGINT NOT NULL DEFAULT 0,
    "transports" TEXT[],
    "deviceType" TEXT NOT NULL,
    "backedUp" BOOLEAN NOT NULL DEFAULT false,
    "name" TEXT NOT NULL,
    "lastUsedAt" TIMESTAMP(3),
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fork_passkeys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fork_recovery_codes" (
    "id" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fork_recovery_codes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "fork_passkeys_credentialId_key" ON "fork_passkeys"("credentialId");

-- CreateIndex
CREATE INDEX "fork_passkeys_userId_idx" ON "fork_passkeys"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "fork_recovery_codes_userId_codeHash_key" ON "fork_recovery_codes"("userId", "codeHash");

-- AddForeignKey
ALTER TABLE "fork_passkeys" ADD CONSTRAINT "fork_passkeys_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fork_recovery_codes" ADD CONSTRAINT "fork_recovery_codes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
