CREATE TYPE "public"."storage_mode" AS ENUM('r2', 'fs', 'indexeddb');--> statement-breakpoint
CREATE TYPE "public"."video_mode" AS ENUM('create', 'remix');--> statement-breakpoint
CREATE TYPE "public"."video_status" AS ENUM('processing', 'completed', 'failed');--> statement-breakpoint
CREATE TABLE "ai_video_history" (
	"id" text PRIMARY KEY NOT NULL,
	"job_created_at" timestamp with time zone NOT NULL,
	"mode" "video_mode" NOT NULL,
	"prompt" text NOT NULL,
	"model" text NOT NULL,
	"size" text NOT NULL,
	"seconds" integer NOT NULL,
	"cost_details" jsonb,
	"status" "video_status" NOT NULL,
	"progress" integer DEFAULT 0 NOT NULL,
	"error" text,
	"remix_of" text,
	"storage_mode" "storage_mode" DEFAULT 'r2' NOT NULL,
	"video_url" text,
	"thumbnail_url" text,
	"spritesheet_url" text,
	"duration_ms" integer,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"has_assets" boolean DEFAULT false NOT NULL
);
