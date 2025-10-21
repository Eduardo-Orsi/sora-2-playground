import { pgEnum, pgTable, text, timestamp, integer, jsonb, boolean } from 'drizzle-orm/pg-core';

export const videoModeEnum = pgEnum('video_mode', ['create', 'remix']);
export const videoStatusEnum = pgEnum('video_status', ['processing', 'completed', 'failed']);
export const storageModeEnum = pgEnum('storage_mode', ['r2', 'fs', 'indexeddb']);

export const videoHistory = pgTable('ai_video_history', {
    id: text('id').primaryKey(),
    jobCreatedAt: timestamp('job_created_at', { withTimezone: true }).notNull(),
    mode: videoModeEnum('mode').notNull(),
    prompt: text('prompt').notNull(),
    model: text('model').notNull(),
    size: text('size').notNull(),
    seconds: integer('seconds').notNull(),
    costDetails: jsonb('cost_details'),
    status: videoStatusEnum('status').notNull(),
    progress: integer('progress').notNull().default(0),
    error: text('error'),
    remixOf: text('remix_of'),
    storageMode: storageModeEnum('storage_mode').notNull().default('r2'),
    videoUrl: text('video_url'),
    thumbnailUrl: text('thumbnail_url'),
    spritesheetUrl: text('spritesheet_url'),
    durationMs: integer('duration_ms'),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    hasAssets: boolean('has_assets').notNull().default(false)
});

export type VideoHistoryRow = typeof videoHistory.$inferSelect;
export type VideoHistoryInsert = typeof videoHistory.$inferInsert;
