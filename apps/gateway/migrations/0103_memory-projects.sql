-- Memories the owner pinned to a project, recalled first in that project's conversations.
CREATE TABLE "memory_projects" (
	"profile_id" uuid NOT NULL,
	"memory_key" text NOT NULL,
	"project_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_projects_profile_id_memory_key_project_id_pk" PRIMARY KEY("profile_id","memory_key","project_id")
);
--> statement-breakpoint
ALTER TABLE "memory_projects" ADD CONSTRAINT "memory_projects_memory_fk" FOREIGN KEY ("profile_id","memory_key") REFERENCES "public"."memories"("profile_id","key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_projects" ADD CONSTRAINT "memory_projects_project_fk" FOREIGN KEY ("profile_id","project_id") REFERENCES "public"."projects"("profile_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memory_projects_project" ON "memory_projects" USING btree ("profile_id","project_id");
