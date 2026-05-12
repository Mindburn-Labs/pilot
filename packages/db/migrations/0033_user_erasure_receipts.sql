CREATE TABLE IF NOT EXISTS "user_erasure_receipts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "subject_hash" text NOT NULL,
  "source" text NOT NULL,
  "actor" text NOT NULL,
  "deleted_workspace_count" integer DEFAULT 0 NOT NULL,
  "workspace_set_hash" text,
  "replay_ref" text NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "requested_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "user_erasure_receipts_subject_hash_idx"
  ON "user_erasure_receipts" ("subject_hash");

CREATE INDEX IF NOT EXISTS "user_erasure_receipts_created_at_idx"
  ON "user_erasure_receipts" ("created_at");
