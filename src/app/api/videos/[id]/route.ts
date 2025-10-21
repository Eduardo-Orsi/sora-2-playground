import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { NextRequest, NextResponse } from 'next/server';
import OpenAI from 'openai';
import { deleteObject, getPublicUrl, uploadObject } from '@/lib/server/r2';
import {
    getVideoRecord,
    markVideoCompleted,
    markVideoFailed,
    removeVideoRecord,
    updateVideoStatus
} from '@/lib/server/video-history';

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: process.env.OPENAI_API_BASE_URL
});

const outputDir = path.resolve(process.cwd(), 'generated-videos');

function sha256(data: string): string {
    return crypto.createHash('sha256').update(data).digest('hex');
}

async function ensureAssets(id: string, createdAt: number) {
    const existing = await getVideoRecord(id);
    if (existing?.videoUrl && existing.status === 'completed') {
        return existing;
    }

    const variants: Array<{
        variant: 'video' | 'thumbnail' | 'spritesheet';
        filename: string;
        contentType: string;
        optional?: boolean;
    }> = [
        { variant: 'video', filename: `${id}/video.mp4`, contentType: 'video/mp4' },
        { variant: 'thumbnail', filename: `${id}/thumbnail.webp`, contentType: 'image/webp', optional: true },
        { variant: 'spritesheet', filename: `${id}/spritesheet.jpg`, contentType: 'image/jpeg', optional: true }
    ];

    const uploaded: Record<string, string | undefined> = {};

    for (const item of variants) {
        try {
            const response = await openai.videos.downloadContent(id, { variant: item.variant });
            const buffer = Buffer.from(await response.arrayBuffer());
            const key = `videos/${item.filename}`;
            await uploadObject(key, buffer, item.contentType);
            uploaded[item.variant] = getPublicUrl(key);
        } catch (error) {
            if (item.optional) {
                console.warn(`Optional asset ${item.variant} unavailable for video ${id}:`, error);
                continue;
            }
            throw error;
        }
    }

    const durationMs = Date.now() - createdAt * 1000;

    await markVideoCompleted({
        id,
        videoUrl: uploaded.video as string,
        thumbnailUrl: uploaded.thumbnail,
        spritesheetUrl: uploaded.spritesheet,
        durationMs
    });

    return await getVideoRecord(id);
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    console.log(`Received GET request to /api/videos/${id}`);

    if (!process.env.OPENAI_API_KEY) {
        console.error('OPENAI_API_KEY is not set.');
        return NextResponse.json({ error: 'Server configuration error: API key not found.' }, { status: 500 });
    }

    try {
        // Password authentication
        const authHeader = request.headers.get('x-password-hash');
        if (process.env.APP_PASSWORD) {
            if (!authHeader) {
                return NextResponse.json({ error: 'Unauthorized: Missing password hash.' }, { status: 401 });
            }
            const serverPasswordHash = sha256(process.env.APP_PASSWORD);
            if (authHeader !== serverPasswordHash) {
                return NextResponse.json({ error: 'Unauthorized: Invalid password.' }, { status: 401 });
            }
        }

        console.log(`Retrieving video status for: ${id}`);

        // Retrieve video job status
        const video = await openai.videos.retrieve(id);

        console.log(`Video ${id} status: ${video.status}, progress: ${video.progress}`);

        let record = null;
        const normalizedStatus =
            video.status === 'completed' ? 'completed' : video.status === 'failed' ? 'failed' : 'processing';
        const progressValue =
            normalizedStatus === 'completed' ? 100 : Number.isFinite(video.progress) ? video.progress ?? 0 : 0;

        try {
            if (normalizedStatus === 'failed') {
                await markVideoFailed({
                    id: video.id,
                    error: video.error?.message ?? null
                });
            } else {
                await updateVideoStatus({
                    id: video.id,
                    status: normalizedStatus,
                    progress: progressValue,
                    error: null
                });

                if (normalizedStatus === 'completed') {
                    record = await ensureAssets(video.id, video.created_at);
                }
            }
            record = record ?? (await getVideoRecord(video.id));
        } catch (dbError) {
            console.error(`Failed to update video history for ${video.id}:`, dbError);
        }

        // Return job status
        return NextResponse.json({
            id: video.id,
            status: video.status,
            progress: progressValue,
            model: video.model,
            size: video.size,
            seconds: video.seconds,
            created_at: video.created_at,
            object: video.object,
            error: video.error,
            videoUrl: record?.videoUrl,
            thumbnailUrl: record?.thumbnailUrl,
            spritesheetUrl: record?.spritesheetUrl,
            storageModeUsed: record?.storageModeUsed ?? 'r2',
            costDetails: record?.costDetails ?? null,
            completedAt: record?.completedAt,
            durationMs: record?.durationMs ?? null
        });
    } catch (error: unknown) {
        console.error(`Error retrieving video ${id}:`, error);

        let errorMessage = 'An unexpected error occurred.';
        let status = 500;

        if (error instanceof Error) {
            errorMessage = error.message;
            if (typeof error === 'object' && error !== null && 'status' in error && typeof error.status === 'number') {
                status = error.status;
            }
        }

        return NextResponse.json({ error: errorMessage }, { status });
    }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    console.log(`Received DELETE request to /api/videos/${id}`);

    if (!process.env.OPENAI_API_KEY) {
        console.error('OPENAI_API_KEY is not set.');
        return NextResponse.json({ error: 'Server configuration error: API key not found.' }, { status: 500 });
    }

    try {
        // Password authentication
        const authHeader = request.headers.get('x-password-hash');
        if (process.env.APP_PASSWORD) {
            if (!authHeader) {
                return NextResponse.json({ error: 'Unauthorized: Missing password hash.' }, { status: 401 });
            }
            const serverPasswordHash = sha256(process.env.APP_PASSWORD);
            if (authHeader !== serverPasswordHash) {
                return NextResponse.json({ error: 'Unauthorized: Invalid password.' }, { status: 401 });
            }
        }

        console.log(`Deleting video: ${id}`);

        // Delete video from OpenAI
        const result = await openai.videos.delete(id);

        console.log(`Video ${id} deleted successfully from OpenAI`);

        // Delete stored assets (R2 or filesystem if configured)
        const explicitMode = process.env.NEXT_PUBLIC_FILE_STORAGE_MODE;
        const isOnVercel = process.env.VERCEL === '1';
        let effectiveStorageMode: 'fs' | 'indexeddb' | 'r2';

        // Prevent fs mode on Vercel (filesystem is read-only/ephemeral)
        if (isOnVercel && explicitMode === 'fs') {
            console.warn('fs mode is not supported on Vercel, forcing indexeddb mode');
            effectiveStorageMode = 'indexeddb';
        } else if (explicitMode === 'r2') {
            effectiveStorageMode = 'r2';
        } else if (explicitMode === 'fs') {
            effectiveStorageMode = 'fs';
        } else if (explicitMode === 'indexeddb') {
            effectiveStorageMode = 'indexeddb';
        } else if (isOnVercel) {
            effectiveStorageMode = 'indexeddb';
        } else {
            effectiveStorageMode = 'r2';
        }

        if (effectiveStorageMode === 'fs') {
            const filesToDelete = [
                `${id}_video.mp4`,
                `${id}_thumbnail.webp`,
                `${id}_spritesheet.jpg`
            ];

            for (const filename of filesToDelete) {
                const filepath = path.join(outputDir, filename);
                try {
                    await fs.unlink(filepath);
                    console.log(`Deleted local file: ${filepath}`);
                } catch (error: unknown) {
                    // File might not exist, which is fine
                    if (typeof error === 'object' && error !== null && 'code' in error && error.code !== 'ENOENT') {
                        console.error(`Error deleting ${filepath}:`, error);
                    }
                }
            }
        } else if (effectiveStorageMode === 'r2') {
            const keys = [`videos/${id}/video.mp4`, `videos/${id}/thumbnail.webp`, `videos/${id}/spritesheet.jpg`];
            await Promise.all(
                keys.map(async key => {
                    try {
                        await deleteObject(key);
                    } catch (error) {
                        console.warn(`Failed to delete R2 object ${key}:`, error);
                    }
                })
            );
        }

        try {
            await removeVideoRecord(id);
        } catch (dbError) {
            console.error(`Failed to delete video record ${id}:`, dbError);
        }

        return NextResponse.json(result);
    } catch (error: unknown) {
        console.error(`Error deleting video ${id}:`, error);

        let errorMessage = 'An unexpected error occurred.';
        let status = 500;

        if (error instanceof Error) {
            errorMessage = error.message;
            if (typeof error === 'object' && error !== null && 'status' in error && typeof error.status === 'number') {
                status = error.status;
            }
        }

        return NextResponse.json({ error: errorMessage }, { status });
    }
}
