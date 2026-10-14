-- CreateEnum
CREATE TYPE "fork_topic_basis" AS ENUM ('OPT_IN', 'OPT_OUT');

-- AlterTable
ALTER TABLE "campaigns" ADD COLUMN     "fork_topic_id" TEXT;

-- AlterTable
ALTER TABLE "projects" ADD COLUMN     "fork_topics_enabled" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "fork_topics" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "basis" "fork_topic_basis" NOT NULL DEFAULT 'OPT_OUT',
    "campaignSelectable" BOOLEAN NOT NULL DEFAULT true,
    "listId" TEXT,
    "projectId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fork_topics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fork_contact_topics" (
    "contactId" TEXT NOT NULL,
    "topicId" TEXT NOT NULL,
    "subscribed" BOOLEAN NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fork_contact_topics_pkey" PRIMARY KEY ("contactId","topicId")
);

-- CreateIndex
CREATE UNIQUE INDEX "fork_topics_projectId_slug_key" ON "fork_topics"("projectId", "slug");

-- CreateIndex
CREATE INDEX "fork_contact_topics_topicId_subscribed_idx" ON "fork_contact_topics"("topicId", "subscribed");

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "fork_campaigns_topic_id_fkey" FOREIGN KEY ("fork_topic_id") REFERENCES "fork_topics"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fork_topics" ADD CONSTRAINT "fork_topics_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fork_contact_topics" ADD CONSTRAINT "fork_contact_topics_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fork_contact_topics" ADD CONSTRAINT "fork_contact_topics_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "fork_topics"("id") ON DELETE CASCADE ON UPDATE CASCADE;
