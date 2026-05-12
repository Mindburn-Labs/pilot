CREATE TABLE IF NOT EXISTS "tenant_deletion_receipts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL,
  "deletion_id" uuid,
  "workspace_name" text,
  "source" text NOT NULL,
  "actor" text NOT NULL,
  "reason" text,
  "soft_deleted_at" timestamp with time zone,
  "hard_delete_after" timestamp with time zone,
  "hard_deleted_at" timestamp with time zone DEFAULT now() NOT NULL,
  "replay_ref" text NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tenant_deletion_receipts_workspace_idx"
  ON "tenant_deletion_receipts" ("workspace_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tenant_deletion_receipts_created_idx"
  ON "tenant_deletion_receipts" ("created_at");
