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

export async function POST(request: NextRequest) {
    console.log('Received POST request to /api/videos');

    if (!process.env.OPENAI_API_KEY) {
        console.error('OPENAI_API_KEY is not set.');
        return NextResponse.json({ error: 'Server configuration error: API key not found.' }, { status: 500 });
    }

    try {
        const formData = await request.formData();

        // Password authentication
        if (process.env.APP_PASSWORD) {
            const clientPasswordHash = formData.get('passwordHash') as string | null;
            if (!clientPasswordHash) {
                console.error('Missing password hash.');
                return NextResponse.json({ error: 'Unauthorized: Missing password hash.' }, { status: 401 });
            }
            const serverPasswordHash = sha256(process.env.APP_PASSWORD);
            if (clientPasswordHash !== serverPasswordHash) {
                console.error('Invalid password hash.');
                return NextResponse.json({ error: 'Unauthorized: Invalid password.' }, { status: 401 });
            }
        }

        const model = (formData.get('model') as 'sora-2' | 'sora-2-pro') || 'sora-2';
        const prompt = formData.get('prompt') as string | null;
        const size = (formData.get('size') as string) || '1280x720';
        const secondsStr = (formData.get('seconds') as string) || '4';
        const input_reference = formData.get('input_reference') as File | null;

        console.log(`Creating video: model=${model}, size=${size}, seconds=${secondsStr}`);

        if (!prompt) {
            return NextResponse.json({ error: 'Missing required parameter: prompt' }, { status: 400 });
        }

        console.log('Calling OpenAI videos.create with params:', {
            model,
            prompt,
            size,
            seconds: secondsStr,
            input_reference: input_reference ? input_reference.name : undefined
        });

        // Create video job
        const createParams = {
            model,
            prompt,
            size,
            seconds: secondsStr,
            ...(input_reference && { input_reference })
        };

        // @ts-expect-error - SDK types may be strict, API handles validation
        const video = await openai.videos.create(createParams);

        console.log('Video job created:', video.id, 'status:', video.status);

        await upsertVideoRecord({
            id: video.id,
            mode: 'create',
            prompt,
            model: video.model,
            size: video.size,
            seconds: video.seconds,
            progress: video.progress ?? 0,
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
            costDetails
        });
    } catch (error: unknown) {
        console.error('Error in /api/videos POST:', error);

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

export async function GET(request: NextRequest) {
    console.log('Received GET request to /api/videos');

    if (!process.env.OPENAI_API_KEY) {
        console.error('OPENAI_API_KEY is not set.');
        return NextResponse.json({ error: 'Server configuration error: API key not found.' }, { status: 500 });
    }

    try {
        // Password authentication for listing
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

        const searchParams = request.nextUrl.searchParams;
        const limit = parseInt(searchParams.get('limit') || '20', 10);
        const after = searchParams.get('after') || undefined;
        const order = (searchParams.get('order') as 'asc' | 'desc') || 'desc';

        console.log(`Listing videos: limit=${limit}, after=${after}, order=${order}`);

        const videos = await openai.videos.list({
            limit,
            after,
            order
        });

        return NextResponse.json(videos);
    } catch (error: unknown) {
        console.error('Error in /api/videos GET:', error);

        let errorMessage = 'An unexpected error occurred.';
        const status = 500;

        if (error instanceof Error) {
            errorMessage = error.message;
        }

        return NextResponse.json({ error: errorMessage }, { status });
    }
}
