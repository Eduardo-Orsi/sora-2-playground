import crypto from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import OpenAI from 'openai';
import { calculateVideoCost } from '@/lib/cost-utils';
import { upsertVideoRecord } from '@/lib/server/video-history';

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: process.env.OPENAI_API_BASE_URL
});

function sha256(data: string): string {
    return crypto.createHash('sha256').update(data).digest('hex');
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    console.log(`Received POST request to /api/videos/${id}/remix`);

    if (!process.env.OPENAI_API_KEY) {
        console.error('OPENAI_API_KEY is not set.');
        return NextResponse.json({ error: 'Server configuration error: API key not found.' }, { status: 500 });
    }

    try {
        const body = await request.json();
        const { prompt, passwordHash } = body;

        // Password authentication
        if (process.env.APP_PASSWORD) {
            if (!passwordHash) {
                console.error('Missing password hash.');
                return NextResponse.json({ error: 'Unauthorized: Missing password hash.' }, { status: 401 });
            }
            const serverPasswordHash = sha256(process.env.APP_PASSWORD);
            if (passwordHash !== serverPasswordHash) {
                console.error('Invalid password hash.');
                return NextResponse.json({ error: 'Unauthorized: Invalid password.' }, { status: 401 });
            }
        }

        if (!prompt) {
            return NextResponse.json({ error: 'Missing required parameter: prompt' }, { status: 400 });
        }

        console.log(`Creating remix for video ${id} with prompt: "${prompt.substring(0, 50)}..."`);

        // Create remix job
        const video = await openai.videos.remix(id, {
            prompt
        });

        console.log('Remix job created:', video.id, 'status:', video.status);

        await upsertVideoRecord({
            id: video.id,
            mode: 'remix',
            prompt,
            model: video.model,
            size: video.size,
            seconds: video.seconds,
            progress: video.progress ?? 0,
            remixOf: id,
            jobCreatedAt: video.created_at
        });

        const costDetails = calculateVideoCost({
            model: video.model,
            size: video.size,
            seconds: Number(video.seconds)
        });

        // Return job metadata
        return NextResponse.json({
            id: video.id,
            status: video.status,
            progress: video.progress ?? 0,
            model: video.model,
            size: video.size,
            seconds: video.seconds,
            created_at: video.created_at,
            object: video.object,
            remix_of: id,
            costDetails
        });
    } catch (error: unknown) {
        console.error(`Error creating remix for video ${id}:`, error);

        let errorMessage = 'An unexpected error occurred.';
        let status = 500;

        if (error instanceof Error) {
            errorMessage = error.message;
            if (typeof error === 'object' && error !== null && 'status' in error && typeof error.status === 'number') {
                status = error.status;
            }
        } else if (typeof error === 'object' && error !== null) {
            if ('message' in error && typeof error.message === 'string') {
                errorMessage = error.message;
            }
            if ('status' in error && typeof error.status === 'number') {
                status = error.status;
            }
        }

        return NextResponse.json({ error: errorMessage }, { status });
    }
}
