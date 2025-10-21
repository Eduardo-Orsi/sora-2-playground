import type { VideoModel, VideoSeconds, VideoSize } from 'openai/resources/videos';
import { CostDetails } from '@/lib/cost-utils';

export type VideoJob = {
    id: string;
    object: 'video';
    created_at: number;
    status: 'queued' | 'in_progress' | 'completed' | 'failed';
    model: VideoModel;
    progress: number; // 0-100
    seconds: VideoSeconds;
    size: VideoSize;
    prompt?: string;
    error?: {
        message: string;
        code?: string;
    };
    remix_of?: string;
    videoUrl?: string;
    thumbnailUrl?: string;
    spritesheetUrl?: string;
    storageModeUsed?: 'fs' | 'indexeddb' | 'r2';
    costDetails?: CostDetails | null;
    durationMs?: number | null;
    completedAt?: string;
};

export type VideoMetadata = {
    id: string;
    timestamp: number;
    filename: string;
    storageModeUsed?: 'fs' | 'indexeddb' | 'r2';
    durationMs: number;
    model: VideoModel;
    size: VideoSize;
    seconds: number;
    prompt: string;
    mode: 'create' | 'remix';
    costDetails: CostDetails | null;
    remix_of?: string;
    status?: 'processing' | 'completed' | 'failed';
    error?: string;
    progress?: number;
    videoUrl?: string;
    thumbnailUrl?: string;
    spritesheetUrl?: string;
    completedAt?: string;
};

export type VideoJobCreate = {
    model: VideoModel;
    prompt: string;
    size: VideoSize;
    seconds: VideoSeconds;
    input_reference?: File;
};
