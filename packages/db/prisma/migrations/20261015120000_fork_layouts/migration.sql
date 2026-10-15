-- AlterTable
ALTER TABLE "campaigns" ADD COLUMN     "fork_layout_id" TEXT;

-- AlterTable
ALTER TABLE "templates" ADD COLUMN     "fork_layout_id" TEXT;

-- CreateTable
CREATE TABLE "fork_layouts" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "html" TEXT NOT NULL,
    "css" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "projectId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fork_layouts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "fork_layouts_projectId_slug_key" ON "fork_layouts"("projectId", "slug");

-- AddForeignKey
ALTER TABLE "templates" ADD CONSTRAINT "fork_templates_layout_id_fkey" FOREIGN KEY ("fork_layout_id") REFERENCES "fork_layouts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "fork_campaigns_layout_id_fkey" FOREIGN KEY ("fork_layout_id") REFERENCES "fork_layouts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fork_layouts" ADD CONSTRAINT "fork_layouts_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
