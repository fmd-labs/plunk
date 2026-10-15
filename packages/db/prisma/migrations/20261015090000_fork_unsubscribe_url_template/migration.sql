-- AlterTable
ALTER TABLE "projects" ADD COLUMN     "fork_unsubscribe_url_template" TEXT;

-- AlterTable
ALTER TABLE "emails" ADD COLUMN     "fork_unsubscribe_reported_at" TIMESTAMP(3);
