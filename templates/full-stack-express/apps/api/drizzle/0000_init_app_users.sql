CREATE TABLE "app_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"external_subject" varchar(255) NOT NULL,
	"display_name" varchar(100) NOT NULL,
	"email" varchar(254),
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_users_external_subject_unique" UNIQUE("external_subject"),
	CONSTRAINT "app_users_status_check" CHECK ("app_users"."status" in ('active', 'disabled'))
);
