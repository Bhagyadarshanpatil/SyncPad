CREATE TABLE IF NOT EXISTS "critical_versions" (
	"id" serial PRIMARY KEY NOT NULL,
	"doc_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"seq" integer NOT NULL,
	"snapshot" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cv_agent_seq_unique" UNIQUE("agent_id","seq")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "documents" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text DEFAULT 'Untitled' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "operations" (
	"id" serial PRIMARY KEY NOT NULL,
	"doc_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"seq" integer NOT NULL,
	"type" text NOT NULL,
	"pos" integer NOT NULL,
	"content" text,
	"parent_ids" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ops_agent_seq_unique" UNIQUE("agent_id","seq")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "critical_versions" ADD CONSTRAINT "critical_versions_doc_id_documents_id_fk" FOREIGN KEY ("doc_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "operations" ADD CONSTRAINT "operations_doc_id_documents_id_fk" FOREIGN KEY ("doc_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cv_doc_id_idx" ON "critical_versions" ("doc_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ops_doc_id_idx" ON "operations" ("doc_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ops_agent_seq_idx" ON "operations" ("agent_id","seq");