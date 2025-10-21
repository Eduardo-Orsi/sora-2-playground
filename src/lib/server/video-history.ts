import { eq } from 'drizzle-orm';
import type { VideoModel, VideoSize } from 'openai/resources/videos';
import { calculateVideoCost, type CostDetails } from '@/lib/cost-utils';
import type { VideoMetadata } from '@/types/video';
import { db } from './db';
import { videoHistory, type VideoHistoryRow } from './schema';

type VideoMode = VideoMetadata['mode'];
type VideoStatus = NonNullable<VideoMetadata['status']>;

function toDate(epochSeconds: number): Date {
    return new Date(epochSeconds * 1000);
}

function mapRow(row: VideoHistoryRow): VideoMetadata {
    return {
        id: row.id,
        timestamp: row.createdAt?.getTime() ?? Date.now(),
        filename: `${row.id}.mp4`,
        storageModeUsed: row.storageMode ?? 'r2',
        durationMs: row.durationMs ?? 0,
        model: row.model as VideoModel,
        size: row.size as VideoSize,
        seconds: row.seconds,
        prompt: row.prompt,
        mode: row.mode,
        costDetails: (row.costDetails as CostDetails | null) ?? null,
        remix_of: row.remixOf ?? undefined,
        status: row.status,
        error: row.error ?? undefined,
        progress: row.progress ?? undefined,
        videoUrl: row.videoUrl ?? undefined,
        thumbnailUrl: row.thumbnailUrl ?? undefined,
        spritesheetUrl: row.spritesheetUrl ?? undefined,
        completedAt: row.completedAt?.toISOString()
    };
}

export async function upsertVideoRecord(input: {
    id: string;
    mode: VideoMode;
    prompt: string;
    model: VideoModel;
    size: VideoSize;
    seconds: number | string;
    progress: number;
    remixOf?: string;
    jobCreatedAt: number;
}) {
    const seconds = typeof input.seconds === 'string' ? parseInt(input.seconds, 10) : input.seconds;
    const costDetails = calculateVideoCost({
        model: input.model,
        size: input.size,
        seconds
    });

    await db
        .insert(videoHistory)
        .values({
            id: input.id,
            mode: input.mode,
            prompt: input.prompt,
            model: input.model,
            size: input.size,
            seconds,
            costDetails,
            status: 'processing',
            progress: input.progress ?? 0,
            remixOf: input.remixOf,
            jobCreatedAt: toDate(input.jobCreatedAt),
            storageMode: 'r2',
            updatedAt: new Date()
        })
        .onConflictDoUpdate({
            target: videoHistory.id,
            set: {
                mode: input.mode,
                prompt: input.prompt,
                model: input.model,
                size: input.size,
                seconds,
                progress: input.progress ?? 0,
                remixOf: input.remixOf,
                updatedAt: new Date()
            }
        });
}

export async function updateVideoStatus(input: {
    id: string;
    status: VideoStatus;
    progress: number;
    error?: string | null;
}) {
    await db
        .update(videoHistory)
        .set({
            status: input.status,
            progress: input.progress,
            error: input.error ?? null,
            updatedAt: new Date()
        })
        .where(eq(videoHistory.id, input.id));
}

export async function markVideoCompleted(input: {
    id: string;
    videoUrl: string;
    thumbnailUrl?: string;
    spritesheetUrl?: string;
    durationMs: number;
}) {
    await db
        .update(videoHistory)
        .set({
            status: 'completed',
            videoUrl: input.videoUrl,
            thumbnailUrl: input.thumbnailUrl ?? null,
            spritesheetUrl: input.spritesheetUrl ?? null,
            durationMs: input.durationMs,
            storageMode: 'r2',
            hasAssets: true,
            completedAt: new Date(),
            updatedAt: new Date()
        })
        .where(eq(videoHistory.id, input.id));
}

export async function markVideoFailed(input: { id: string; error: string | null }) {
    await db
        .update(videoHistory)
        .set({
            status: 'failed',
            error: input.error,
            progress: 0,
            updatedAt: new Date()
        })
        .where(eq(videoHistory.id, input.id));
}

export async function listVideoHistory(limit = 100): Promise<VideoMetadata[]> {
    const rows = await db.query.videoHistory.findMany({
        orderBy: (fields, { desc }) => desc(fields.createdAt),
        limit
    });
    return rows.map(mapRow);
}

export async function getVideoRecord(id: string) {
    const row = await db.query.videoHistory.findFirst({
        where: (fields, { eq: equals }) => equals(fields.id, id)
    });
    return row ? mapRow(row) : null;
}

export async function removeVideoRecord(id: string) {
    await db.delete(videoHistory).where(eq(videoHistory.id, id));
}

export async function removeAllVideoRecords() {
    await db.delete(videoHistory);
}
