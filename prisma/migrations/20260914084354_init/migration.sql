-- CreateTable
CREATE TABLE "agent_workflows" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "trigger_code" TEXT NOT NULL,
    "description" TEXT,
    "prompt" TEXT,
    "tools_id" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "agent_workflows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tool_definitions" (
    "pid" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "tool_code" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "tool_definitions_pkey" PRIMARY KEY ("pid")
);

-- CreateTable
CREATE TABLE "flow_trackings" (
    "id" UUID NOT NULL,
    "workflow_id" UUID NOT NULL,
    "status" TEXT NOT NULL,
    "data" JSONB,
    "cost" DECIMAL(12,6),
    "tokens" INTEGER,
    "model" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "flow_trackings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "flow_trackings_workflow_id_idx" ON "flow_trackings"("workflow_id");

-- AddForeignKey
ALTER TABLE "flow_trackings" ADD CONSTRAINT "flow_trackings_workflow_id_fkey" FOREIGN KEY ("workflow_id") REFERENCES "agent_workflows"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
