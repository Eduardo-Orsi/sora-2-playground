import crypto from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { listVideoHistory, removeAllVideoRecords } from '@/lib/server/video-history';

function sha256(data: string): string {
    return crypto.createHash('sha256').update(data).digest('hex');
}

function verifyPassword(request: NextRequest): { authorized: boolean; response?: NextResponse } {
    if (!process.env.APP_PASSWORD) {
        return { authorized: true };
    }

    const clientPasswordHash = request.headers.get('x-password-hash');

    if (!clientPasswordHash) {
        return {
            authorized: false,
            response: NextResponse.json({ error: 'Unauthorized: Missing password hash.' }, { status: 401 })
        };
    }

    const serverPasswordHash = sha256(process.env.APP_PASSWORD);
    if (clientPasswordHash !== serverPasswordHash) {
        return {
            authorized: false,
            response: NextResponse.json({ error: 'Unauthorized: Invalid password.' }, { status: 401 })
        };
    }

    return { authorized: true };
}

export async function GET(request: NextRequest) {
    const auth = verifyPassword(request);
    if (!auth.authorized) {
        return auth.response!;
    }

    try {
        const items = await listVideoHistory();
        return NextResponse.json({ items });
    } catch (error) {
        console.error('Failed to list video history:', error);
        return NextResponse.json({ error: 'Failed to fetch video history' }, { status: 500 });
    }
}

export async function DELETE(request: NextRequest) {
    const auth = verifyPassword(request);
    if (!auth.authorized) {
        return auth.response!;
    }

    try {
        await removeAllVideoRecords();
        return NextResponse.json({ ok: true });
    } catch (error) {
        console.error('Failed to clear video history:', error);
        return NextResponse.json({ error: 'Failed to clear history' }, { status: 500 });
    }
}
