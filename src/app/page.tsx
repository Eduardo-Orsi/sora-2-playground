'use client';

import type { VideoModel, VideoSeconds, VideoSize } from 'openai/resources/videos';
import { CreationForm, type CreationFormData } from '@/components/creation-form';
import { RemixForm, type RemixFormData } from '@/components/remix-form';
import { VideoHistoryPanel } from '@/components/video-history-panel';
import { VideoOutput } from '@/components/video-output';
import { PasswordDialog } from '@/components/password-dialog';
import { ApiKeyDialog } from '@/components/api-key-dialog';
import { ApiKeyGate } from '@/components/api-key-gate';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { AlertCircle } from 'lucide-react';
import { calculateVideoCost } from '@/lib/cost-utils';
import { db, type VideoRecord } from '@/lib/db';
import { VideoService, type ApiMode } from '@/lib/video-service';
import { verifyFrontendApiKey } from '@/lib/openai-client';
import { InvalidApiKeyError } from '@/lib/errors';
import { useLiveQuery } from 'dexie-react-hooks';
import * as React from 'react';
import type { VideoJob, VideoMetadata } from '@/types/video';

const VIDEO_SECONDS_VALUES = ['4', '8', '12'] as const;

const toVideoSeconds = (value: number | string): VideoSeconds => {
    const normalized = value.toString();
    if ((VIDEO_SECONDS_VALUES as readonly string[]).includes(normalized)) {
        return normalized as VideoSeconds;
    }
    throw new Error(`Unsupported video seconds value: ${value}`);
};

const explicitModeClient = process.env.NEXT_PUBLIC_FILE_STORAGE_MODE;
const vercelEnvClient = process.env.NEXT_PUBLIC_VERCEL_ENV;
const isOnVercelClient = vercelEnvClient === 'production' || vercelEnvClient === 'preview';

// Frontend mode detection
const isFrontendModeEnabled = process.env.NEXT_PUBLIC_ENABLE_FRONTEND_MODE === 'true';

const initialApiMode: ApiMode = isFrontendModeEnabled ? 'frontend' : 'backend';
const getStoredApiKey = (): string | null => {
    if (typeof window === 'undefined' || !isFrontendModeEnabled) {
        return null;
    }
    return localStorage.getItem('openaiApiKey');
};

let effectiveStorageModeClient: 'fs' | 'indexeddb' | 'r2';

// Frontend mode always uses indexeddb (no backend filesystem available)
if (isFrontendModeEnabled) {
    effectiveStorageModeClient = 'indexeddb';
    console.log('Frontend mode enabled - forcing indexeddb storage');
} else if (explicitModeClient === 'r2') {
    effectiveStorageModeClient = 'r2';
} else if (isOnVercelClient && explicitModeClient === 'fs') {
    // Prevent fs mode on Vercel (filesystem is read-only/ephemeral)
    console.warn('fs mode is not supported on Vercel, forcing indexeddb mode');
    effectiveStorageModeClient = 'indexeddb';
} else if (explicitModeClient === 'fs') {
    effectiveStorageModeClient = 'fs';
} else if (explicitModeClient === 'indexeddb') {
    effectiveStorageModeClient = 'indexeddb';
} else if (isOnVercelClient) {
    effectiveStorageModeClient = 'indexeddb';
} else {
    effectiveStorageModeClient = 'r2';
}

console.log(
    `Client Effective Storage Mode: ${effectiveStorageModeClient} (Explicit: ${explicitModeClient || 'unset'}, Vercel Env: ${vercelEnvClient || 'N/A'}, Frontend Mode: ${isFrontendModeEnabled})`
);

export default function HomePage() {
    const [mode, setMode] = React.useState<'create' | 'remix'>('create');
    const [isPasswordRequiredByBackend, setIsPasswordRequiredByBackend] = React.useState<boolean | null>(
        isFrontendModeEnabled ? false : null
    );
    const [clientPasswordHash, setClientPasswordHash] = React.useState<string | null>(null);
    const [error, setError] = React.useState<string | null>(null);
    const [isPasswordDialogOpen, setIsPasswordDialogOpen] = React.useState(false);
    const [passwordDialogContext, setPasswordDialogContext] = React.useState<'initial' | 'retry'>('initial');
    const [forceDeleteDialogOpen, setForceDeleteDialogOpen] = React.useState(false);
    const [itemToForceDelete, setItemToForceDelete] = React.useState<VideoMetadata | null>(null);

    // Frontend mode state
    const [apiMode, setApiMode] = React.useState<ApiMode>(initialApiMode);
    const [clientApiKey, setClientApiKey] = React.useState<string | null>(() => getStoredApiKey());
    const [isApiKeyDialogOpen, setIsApiKeyDialogOpen] = React.useState(false);

    // Job tracking
    const [activeJobs, setActiveJobs] = React.useState<Map<string, VideoJob>>(new Map());
    const activeJobsRef = React.useRef(activeJobs);
    const [pollingInterval, setPollingInterval] = React.useState<NodeJS.Timeout | null>(null);
    const [currentJobId, setCurrentJobId] = React.useState<string | null>(null);
    const [videoSrcCache, setVideoSrcCache] = React.useState<Map<string, string>>(new Map());
    const [isSubmitting, setIsSubmitting] = React.useState(false);

    // Keep ref in sync with state
    React.useEffect(() => {
        activeJobsRef.current = activeJobs;
    }, [activeJobs]);

    // Memoize a stable key for active job IDs to trigger polling effect
    const activeJobIdsKey = React.useMemo(() => {
        const ids = Array.from(activeJobs.keys()).filter(id => !id.startsWith('temp_'));
        return ids.join('|');
    }, [activeJobs]);

    // Helper to save active job IDs to localStorage
    const saveActiveJobIds = React.useCallback((jobs: Map<string, VideoJob>) => {
        const activeIds = Array.from(jobs.keys()).filter(id => !id.startsWith('temp_'));
        localStorage.setItem('activeVideoJobs', JSON.stringify(activeIds));
    }, []);

    // History
    const [history, setHistory] = React.useState<VideoMetadata[]>([]);
    const [isInitialLoad, setIsInitialLoad] = React.useState(true);

    // Creation form state
    const [createModel, setCreateModel] = React.useState<VideoModel>('sora-2');
    const [createPrompt, setCreatePrompt] = React.useState('');
    const [createSize, setCreateSize] = React.useState<VideoSize>('720x1280');
    const [createSeconds, setCreateSeconds] = React.useState<VideoSeconds>('4');
    const [createInputReference, setCreateInputReference] = React.useState<File | null>(null);

    // Remix form state
    const [remixSourceVideoId, setRemixSourceVideoId] = React.useState('');
    const [remixPrompt, setRemixPrompt] = React.useState('');

    const allDbVideos = useLiveQuery<VideoRecord[] | undefined>(() => db.videos.toArray(), []);

    const fetchHistory = React.useCallback(async () => {
        if (isFrontendModeEnabled || apiMode === 'frontend') {
            return;
        }

        if (isPasswordRequiredByBackend === null) {
            return;
        }

        if (isPasswordRequiredByBackend && !clientPasswordHash) {
            return;
        }

        try {
            const response = await fetch('/api/video-history', {
                headers: clientPasswordHash ? { 'x-password-hash': clientPasswordHash } : {}
            });

            if (!response.ok) {
                throw new Error('Failed to fetch video history');
            }

            const data = await response.json();
            if (Array.isArray(data.items)) {
                setHistory(data.items);
            }
        } catch (err) {
            console.error('Failed to fetch video history:', err);
            setError(err instanceof Error ? err.message : 'Failed to fetch video history');
        } finally {
            setIsInitialLoad(false);
        }
    }, [apiMode, clientPasswordHash, isPasswordRequiredByBackend]);

    // Load history for current mode
    React.useEffect(() => {
        let cancelled = false;

        const load = async () => {
            if (isFrontendModeEnabled || apiMode === 'frontend') {
                try {
                    const storedHistory = localStorage.getItem('soraVideoHistory');
                    if (storedHistory) {
                        const parsedHistory: VideoMetadata[] = JSON.parse(storedHistory);
                        if (Array.isArray(parsedHistory)) {
                            setHistory(parsedHistory);
                        } else {
                            console.warn('Invalid history data found in localStorage.');
                            localStorage.removeItem('soraVideoHistory');
                        }
                    } else {
                        setHistory([]);
                    }
                } catch (e) {
                    console.error('Failed to load or parse history from localStorage:', e);
                    localStorage.removeItem('soraVideoHistory');
                } finally {
                    if (!cancelled) {
                        setIsInitialLoad(false);
                    }
                }
                return;
            }

            await fetchHistory();
        };

        load();

        return () => {
            cancelled = true;
        };
    }, [apiMode, fetchHistory]);

    // Save history to localStorage when running purely in frontend mode
    React.useEffect(() => {
        if (isFrontendModeEnabled || apiMode === 'frontend') {
            if (!isInitialLoad) {
                try {
                    localStorage.setItem('soraVideoHistory', JSON.stringify(history));
                } catch (e) {
                    console.error('Failed to save history to localStorage:', e);
                }
            }
        }
    }, [history, isInitialLoad, apiMode]);

    // Check password requirement and validate stored hash
    React.useEffect(() => {
        if (isFrontendModeEnabled) {
            setIsPasswordRequiredByBackend(false);
            setClientPasswordHash(null);
            if (typeof window !== 'undefined') {
                localStorage.removeItem('clientPasswordHash');
            }
            return;
        }

        const fetchAuthStatus = async () => {
            try {
                // Check if we have a stored password hash
                const storedHash = localStorage.getItem('clientPasswordHash');

                // Call auth-status with stored hash (if exists) for validation
                const response = await fetch('/api/auth-status', {
                    headers: storedHash ? { 'x-password-hash': storedHash } : {}
                });

                if (!response.ok) {
                    throw new Error('Failed to fetch auth status');
                }

                const data = await response.json();
                const passwordRequired = data.passwordRequired;
                const isValid = data.valid;

                setIsPasswordRequiredByBackend(passwordRequired);

                // Handle different scenarios
                if (!passwordRequired) {
                    // No password required, clear any stored hash
                    if (storedHash) {
                        localStorage.removeItem('clientPasswordHash');
                        setClientPasswordHash(null);
                    }
                } else if (storedHash && isValid === false) {
                    // Stored hash is invalid (password changed on server)
                    console.log('Stored password hash is invalid, clearing and prompting for new password');
                    localStorage.removeItem('clientPasswordHash');
                    setClientPasswordHash(null);
                    setPasswordDialogContext('retry');
                    setIsPasswordDialogOpen(true);
                } else if (storedHash && isValid === true) {
                    // Stored hash is valid
                    setClientPasswordHash(storedHash);
                } else if (!storedHash && passwordRequired) {
                    // Password is required but not set - show dialog immediately
                    console.log('Password required but not set, showing dialog');
                    setPasswordDialogContext('initial');
                    setIsPasswordDialogOpen(true);
                }
            } catch (error) {
                console.error('Error fetching auth status:', error);
                setIsPasswordRequiredByBackend(false);
            }
        };

        fetchAuthStatus();
    }, []);

    // Refresh content when password becomes available
    React.useEffect(() => {
        if (clientPasswordHash && isPasswordRequiredByBackend) {
            console.log('Password authenticated - content fetching is now enabled');
            // The guards in getVideoSrc and getThumbnailSrc will now allow API calls
            // Components will automatically re-render and fetch content since the callbacks depend on clientPasswordHash
        }
    }, [clientPasswordHash, isPasswordRequiredByBackend]);

    // Initialize frontend mode and API key
    React.useEffect(() => {
        if (!isFrontendModeEnabled) {
            return;
        }
        if (apiMode !== 'frontend') {
            setApiMode('frontend');
        }
        if (clientApiKey !== null) {
            return;
        }
        const storedApiKey = getStoredApiKey();
        if (storedApiKey) {
            setClientApiKey(storedApiKey);
        }
    }, [apiMode, clientApiKey]);

    React.useEffect(() => {
        if (isFrontendModeEnabled) {
            console.log('Frontend mode enabled');
        }
    }, []);

    // Create VideoService instance
    const videoService = React.useMemo(() => {
        return new VideoService({
            mode: apiMode,
            clientApiKey,
            clientPasswordHash,
            baseURL: process.env.NEXT_PUBLIC_OPENAI_API_BASE_URL
        });
    }, [apiMode, clientApiKey, clientPasswordHash]);

    // Cleanup polling interval on unmount
    React.useEffect(() => {
        return () => {
            if (pollingInterval) {
                clearInterval(pollingInterval);
            }
        };
    }, [pollingInterval]);

    async function sha256Client(text: string): Promise<string> {
        const encoder = new TextEncoder();
        const data = encoder.encode(text);
        const hashBuffer = await crypto.subtle.digest('SHA-256', data);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        const hashHex = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
        return hashHex;
    }

    const handleSavePassword = async (password: string) => {
        if (!password.trim()) {
            setError('Password cannot be empty.');
            return;
        }
        try {
            const hash = await sha256Client(password);
            localStorage.setItem('clientPasswordHash', hash);
            setClientPasswordHash(hash);
            setError(null);
            setIsPasswordDialogOpen(false);
        } catch (e) {
            console.error('Error hashing password:', e);
            setError('Failed to save password due to a hashing error.');
        }
    };

    const handleSaveApiKey = async (apiKey: string) => {
        const trimmedKey = apiKey.trim();

        if (!trimmedKey) {
            throw new Error('API key cannot be empty.');
        }

        if (!trimmedKey.startsWith('sk-')) {
            throw new Error('API key format looks incorrect. It should start with “sk-”.');
        }

        try {
            await verifyFrontendApiKey(trimmedKey, process.env.NEXT_PUBLIC_OPENAI_API_BASE_URL);
        } catch (error) {
            if (error instanceof InvalidApiKeyError) {
                throw new Error('OpenAI rejected this API key. Please double-check and try again.');
            }
            console.error('Error verifying API key:', error);
            throw new Error('Failed to verify API key. Please try again.');
        }

        try {
            localStorage.setItem('openaiApiKey', trimmedKey);
        } catch (storageError) {
            console.error('Error saving API key:', storageError);
            throw new Error('Failed to persist API key. Please ensure storage is available.');
        }

        setClientApiKey(trimmedKey);
        setError(null);
    };

    const handleOpenApiKeyDialog = () => {
        setIsApiKeyDialogOpen(true);
    };

    const handleInvalidApiKey = React.useCallback(
        (message = 'Your OpenAI API key was rejected. Please enter a new key.') => {
            if (typeof window !== 'undefined') {
                localStorage.removeItem('openaiApiKey');
            }
            setClientApiKey(null);
            setIsApiKeyDialogOpen(true);
            setError(message);
        },
        [setClientApiKey, setError, setIsApiKeyDialogOpen]
    );

    const getVideoSrc = React.useCallback(
        (id: string): string | undefined => {
            // Don't return video source for failed or processing videos
            const historyItem = history.find(h => h.id === id);
            if (historyItem?.status === 'failed' || historyItem?.status === 'processing') {
                return undefined;
            }

            if (historyItem?.videoUrl) {
                return historyItem.videoUrl;
            }

            // Check cache first
            if (videoSrcCache.has(id)) {
                return videoSrcCache.get(id);
            }

            // Check IndexedDB (always used in frontend mode and indexeddb storage mode)
            const record = allDbVideos?.find((vid) => vid.id === id);
            if (record?.blob) {
                const url = URL.createObjectURL(record.blob);
                // Don't set state during render - cache will be set when video is downloaded
                return url;
            }

            // Frontend mode only uses IndexedDB - if not found, video hasn't been downloaded yet
            if (apiMode === 'frontend') {
                return undefined;
            }

            // Backend mode: use API endpoints
            // Don't attempt API call if we haven't determined password requirement yet
            if (isPasswordRequiredByBackend === null) {
                return undefined;
            }

            // Don't attempt API call if password is required but not provided
            if (isPasswordRequiredByBackend && !clientPasswordHash) {
                return undefined;
            }

            // Fallback to filesystem API with password hash as query param
            const url = `/api/videos/${id}/content`;
            if (clientPasswordHash) {
                return `${url}?password-hash=${encodeURIComponent(clientPasswordHash)}`;
            }
            return url;
        },
        [allDbVideos, videoSrcCache, history, isPasswordRequiredByBackend, clientPasswordHash, apiMode]
    );

    const getThumbnailSrc = React.useCallback(
        (id: string): string | undefined => {
            // Don't return thumbnail for failed or processing videos
            const historyItem = history.find(h => h.id === id);
            if (historyItem?.status === 'failed' || historyItem?.status === 'processing') {
                return undefined;
            }

            if (historyItem?.thumbnailUrl) {
                return historyItem.thumbnailUrl;
            }

            // Check IndexedDB (always used in frontend mode and indexeddb storage mode)
            const record = allDbVideos?.find((vid) => vid.id === id);
            if (record?.thumbnail) {
                return URL.createObjectURL(record.thumbnail);
            }

            // Frontend mode only uses IndexedDB - if not found, thumbnail hasn't been downloaded yet
            if (apiMode === 'frontend') {
                return undefined;
            }

            // Backend mode: use API endpoints
            // Don't attempt API call if we haven't determined password requirement yet
            if (isPasswordRequiredByBackend === null) {
                return undefined;
            }

            // Don't attempt API call if password is required but not provided
            if (isPasswordRequiredByBackend && !clientPasswordHash) {
                return undefined;
            }

            // Build URL with password hash as query param if needed
            const url = `/api/videos/${id}/content?variant=thumbnail`;
            if (clientPasswordHash) {
                return `${url}&password-hash=${encodeURIComponent(clientPasswordHash)}`;
            }
            return url;
        },
        [allDbVideos, history, isPasswordRequiredByBackend, clientPasswordHash, apiMode]
    );

    // Single polling interval for all active jobs
    React.useEffect(() => {
        // Get non-temp active jobs that are still processing
        const realJobs = Array.from(activeJobs.entries()).filter(
            ([id, job]) => !id.startsWith('temp_') && job.status !== 'completed' && job.status !== 'failed'
        );

        const hasActiveJobs = realJobs.length > 0;

        // Stop polling if no active jobs
        if (!hasActiveJobs) {
            if (pollingInterval) {
                console.log('No active jobs, stopping polling');
                clearInterval(pollingInterval);
                setPollingInterval(null);
            }
            return;
        }

        // Start polling if we don't have an interval yet
        if (!pollingInterval && hasActiveJobs) {
            console.log(`Starting polling for ${realJobs.length} active job(s)`);

            // Define the polling function
            const pollAllJobs = async () => {
                // Get current real jobs from ref (always latest) that are still processing
                const currentRealJobs = Array.from(activeJobsRef.current.entries()).filter(
                    ([id, job]) => !id.startsWith('temp_') && job.status !== 'completed' && job.status !== 'failed'
                );

                if (currentRealJobs.length === 0) {
                    console.log('No jobs to poll');
                    return;
                }

                // Poll each job sequentially
                for (const [jobId, job] of currentRealJobs) {
                    try {
                        const jobUpdate: VideoJob = await videoService.retrieveVideo(jobId);
                        console.log(`Job ${jobId} status: ${jobUpdate.status}, progress: ${jobUpdate.progress}`);

                            // Update active jobs
                            setActiveJobs(prev => {
                                const existingJob = prev.get(jobId);
                                if (!existingJob) return prev;

                                const updatedJob = {
                                    ...jobUpdate,
                                    prompt: existingJob.prompt || jobUpdate.prompt,
                                    remix_of: existingJob.remix_of || jobUpdate.remix_of
                                };

                                const newJobs = new Map(prev);
                                newJobs.set(jobId, updatedJob);
                                return newJobs;
                            });

                            // Update history item with progress
                            setHistory(prev =>
                                prev.map(item => {
                                    if (item.id === jobId) {
                                        const nextStatus =
                                            jobUpdate.status === 'completed'
                                                ? 'completed'
                                                : jobUpdate.status === 'failed'
                                                    ? 'failed'
                                                    : 'processing';
                                        return {
                                            ...item,
                                            progress: jobUpdate.progress ?? item.progress ?? 0,
                                            status: nextStatus,
                                            storageModeUsed:
                                                jobUpdate.storageModeUsed !== undefined
                                                    ? jobUpdate.storageModeUsed
                                                    : item.storageModeUsed,
                                            videoUrl: jobUpdate.videoUrl ?? item.videoUrl,
                                            thumbnailUrl: jobUpdate.thumbnailUrl ?? item.thumbnailUrl,
                                            spritesheetUrl: jobUpdate.spritesheetUrl ?? item.spritesheetUrl,
                                            durationMs:
                                                jobUpdate.durationMs !== undefined && jobUpdate.durationMs !== null
                                                    ? jobUpdate.durationMs
                                                    : item.durationMs,
                                            costDetails:
                                                jobUpdate.costDetails !== undefined
                                                    ? jobUpdate.costDetails
                                                    : item.costDetails,
                                            completedAt: jobUpdate.completedAt ?? item.completedAt
                                        };
                                    }
                                    return item;
                                })
                            );

                            if (jobUpdate.status === 'completed') {
                                // Remove from active jobs FIRST to prevent duplicate downloads
                                setActiveJobs(prev => {
                                    const newJobs = new Map(prev);
                                    newJobs.delete(jobId);
                                    saveActiveJobIds(newJobs);
                                    return newJobs;
                                });

                                // Download and store video (async, won't block next poll)
                                downloadAndStoreVideo({
                                    ...jobUpdate,
                                    prompt: job.prompt || jobUpdate.prompt,
                                    remix_of: job.remix_of || jobUpdate.remix_of
                                }).catch(err => {
                                    if (err instanceof InvalidApiKeyError) {
                                        handleInvalidApiKey();
                                        return;
                                    }
                                    console.error(`Error downloading completed video ${jobId}:`, err);
                                    setError(err instanceof Error ? err.message : 'Failed to download video');
                                });
                            } else if (jobUpdate.status === 'failed') {
                                // Update history with error and remove cost
                                setHistory(prev =>
                                    prev.map(item => {
                                        if (item.id === jobId) {
                                            return {
                                                ...item,
                                                status: 'failed',
                                                error: jobUpdate.error?.message || 'Video generation failed',
                                                costDetails: null,
                                                videoUrl: undefined,
                                                thumbnailUrl: undefined,
                                                spritesheetUrl: undefined
                                            };
                                        }
                                        return item;
                                    })
                                );
                                // Remove from active jobs
                                setActiveJobs(prev => {
                                    const newJobs = new Map(prev);
                                    newJobs.delete(jobId);
                                    saveActiveJobIds(newJobs);
                                    return newJobs;
                                });
                                setError(jobUpdate.error?.message || 'Video generation failed');
                            }
                    } catch (err) {
                        if (err instanceof InvalidApiKeyError) {
                            handleInvalidApiKey();
                            setActiveJobs(new Map());
                            saveActiveJobIds(new Map());
                            return;
                        }
                        console.error(`Error polling job ${jobId}:`, err);
                        // Don't stop polling other jobs if one fails
                    }
                }
            };

            // Poll immediately on start
            pollAllJobs();

            // Then continue polling every 10 seconds
            const interval = setInterval(pollAllJobs, 10000);

            setPollingInterval(interval);
        }

        // Cleanup when effect re-runs or component unmounts
        // Note: Only clear if we're about to create a new one or unmounting
        return undefined;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeJobIdsKey, clientPasswordHash, clientApiKey, apiMode]);

    // Resume active jobs on initial load
    React.useEffect(() => {
        if (!isInitialLoad && history.length > 0) {
            // Check for active jobs and resume them
            const activeJobIds = JSON.parse(localStorage.getItem('activeVideoJobs') || '[]');
            const processingJobs = history.filter(
                item => item.status === 'processing' && activeJobIds.includes(item.id)
            );

            if (processingJobs.length > 0) {
                console.log(`Found ${processingJobs.length} active jobs to resume`);

                const restoredJobs = new Map<string, VideoJob>();

                processingJobs.forEach(item => {
                    console.log(`Resuming job: ${item.id}`);

                    // Recreate the job in activeJobs
                    const restoredJob: VideoJob = {
                        id: item.id,
                        object: 'video',
                        created_at: item.timestamp / 1000, // Convert to seconds
                        status: 'in_progress', // Will be updated by polling
                        model: item.model,
                        progress: item.progress || 0,
                        seconds: toVideoSeconds(item.seconds),
                        size: item.size,
                        prompt: item.prompt,
                        remix_of: item.remix_of
                    };

                    restoredJobs.set(item.id, restoredJob);
                });

                // Set all restored jobs at once
                setActiveJobs(restoredJobs);

                console.log('Restored jobs will be picked up by the polling interval');
            }
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isInitialLoad]);

    const downloadAndStoreVideo = async (job: VideoJob) => {
        console.log(`Handling completed video job: ${job.id}`);

        if (effectiveStorageModeClient !== 'indexeddb') {
            setHistory(prev =>
                prev.map(item => {
                    if (item.id === job.id) {
                        const fallbackDuration = Math.max(Date.now() - job.created_at * 1000, 0);
                        return {
                            ...item,
                            status: 'completed',
                            storageModeUsed: job.storageModeUsed ?? item.storageModeUsed ?? 'r2',
                            videoUrl: job.videoUrl ?? item.videoUrl,
                            thumbnailUrl: job.thumbnailUrl ?? item.thumbnailUrl,
                            spritesheetUrl: job.spritesheetUrl ?? item.spritesheetUrl,
                            durationMs:
                                job.durationMs !== undefined && job.durationMs !== null
                                    ? job.durationMs
                                    : item.durationMs ?? fallbackDuration,
                            completedAt: job.completedAt ?? item.completedAt
                        };
                    }
                    return item;
                })
            );

            if (!isFrontendModeEnabled && apiMode === 'backend') {
                await fetchHistory();
            }
            return;
        }

        console.log(`Downloading video for job: ${job.id}`);

        try {
            // Download video content
            const blob = await videoService.downloadContent(job.id, 'video');
            const filename = `${job.id}.mp4`;

            // Download thumbnail proactively
            let thumbnailBlob: Blob | undefined;
            try {
                console.log(`Downloading thumbnail for video ${job.id}...`);
                thumbnailBlob = await videoService.downloadContent(job.id, 'thumbnail');
                console.log(`Downloaded thumbnail for video ${job.id}`);
            } catch (err: unknown) {
                if (err instanceof InvalidApiKeyError) {
                    handleInvalidApiKey();
                    return;
                }
                if (typeof err === 'object' && err !== null && 'status' in err && (err as { status?: number }).status === 404) {
                    console.warn(`Thumbnail not available yet for ${job.id}, skipping`);
                } else {
                    console.error(`Error downloading thumbnail for ${job.id}:`, err);
                }
            }

            // Download spritesheet proactively (for future timeline scrubbing)
            try {
                console.log(`Downloading spritesheet for video ${job.id}...`);
                await videoService.downloadContent(job.id, 'spritesheet');
                console.log(`Downloaded spritesheet for video ${job.id}`);
                // Spritesheet is saved to filesystem by the API endpoint in backend mode
                // We're not storing it in IndexedDB for now since it's mainly for future features
            } catch (err: unknown) {
                if (err instanceof InvalidApiKeyError) {
                    handleInvalidApiKey();
                    return;
                }
                if (typeof err === 'object' && err !== null && 'status' in err && (err as { status?: number }).status === 404) {
                    console.warn(`Spritesheet not available yet for ${job.id}, skipping`);
                } else {
                    console.error(`Error downloading spritesheet for ${job.id}:`, err);
                }
            }

            // Store in IndexedDB if needed
            if (effectiveStorageModeClient === 'indexeddb') {
                await db.videos.put({
                    id: job.id,
                    filename,
                    blob,
                    thumbnail: thumbnailBlob,
                    created_at: job.created_at
                });
                console.log(`Saved video ${job.id} with thumbnail to IndexedDB`);

                // Create blob URL for immediate display
                const blobUrl = URL.createObjectURL(blob);
                setVideoSrcCache((prev) => new Map(prev).set(job.id, blobUrl));
            }

            // Calculate total duration from job creation to completion (created_at is Unix timestamp in seconds)
            const durationMs = Date.now() - job.created_at * 1000;

            // Update the existing history entry with completion data
            setHistory((prev) => {
                return prev.map((item) => {
                    if (item.id === job.id) {
                        // Update existing entry with completion data
                        return {
                            ...item,
                            durationMs,
                            storageModeUsed: effectiveStorageModeClient,
                            status: 'completed' as const
                        };
                    }
                    return item;
                });
            });
            console.log(`Video ${job.id} completed and history updated`);
        } catch (err) {
            if (err instanceof InvalidApiKeyError) {
                handleInvalidApiKey();
                return;
            }
            console.error(`Error downloading video ${job.id}:`, err);
            setError(err instanceof Error ? err.message : 'Failed to download video');
        }
    };

    const handleCreateVideo = async (formData: CreationFormData) => {
        setError(null);
        setIsSubmitting(true);

        // Backend mode: check password
        if (apiMode === 'backend' && isPasswordRequiredByBackend && !clientPasswordHash) {
            setError('Password is required. Please configure the password by clicking the lock icon.');
            setPasswordDialogContext('initial');
            setIsPasswordDialogOpen(true);
            setIsSubmitting(false);
            return;
        }

        // Frontend mode: check API key (shouldn't reach here with gate, but defensive)
        if (apiMode === 'frontend' && !clientApiKey) {
            setError('OpenAI API key is required for frontend mode.');
            setIsSubmitting(false);
            return;
        }

        // Create a temporary job to show immediate feedback
        const tempId = `temp_${Date.now()}`;
        const tempJob: VideoJob = {
            id: tempId,
            object: 'video',
            created_at: Date.now() / 1000,
            status: 'queued',
            model: formData.model,
            progress: 0,
            seconds: formData.seconds,
            size: formData.size,
            prompt: formData.prompt
        };

        // Show temporary job immediately
        setActiveJobs((prev) => new Map(prev).set(tempId, tempJob));
        setCurrentJobId(tempId);

        try {
            console.log('Creating video job...');

            const result = await videoService.createVideo({
                model: formData.model,
                prompt: formData.prompt,
                size: formData.size,
                seconds: formData.seconds,
                input_reference: formData.input_reference
            });

            console.log('Video job created:', result);

            // Remove temporary job and add real job
            setActiveJobs((prev) => {
                const newJobs = new Map(prev);
                newJobs.delete(tempId);
                const job: VideoJob = {
                    ...result,
                    prompt: formData.prompt // Store the prompt with the job
                };
                newJobs.set(job.id, job);
                return newJobs;
            });

            const job: VideoJob = {
                ...result,
                prompt: formData.prompt
            };
            setCurrentJobId(job.id);

            // Calculate cost immediately
            const costDetails =
                job.costDetails !== undefined
                    ? job.costDetails
                    : calculateVideoCost({
                          model: job.model,
                          size: job.size,
                          seconds: parseInt(job.seconds)
                      });

            // Add to history immediately with queued status
            const newHistoryEntry: VideoMetadata = {
                id: job.id,
                timestamp: Date.now(),
                filename: `${job.id}.mp4`,
                storageModeUsed: effectiveStorageModeClient,
                durationMs: 0, // Will be updated when complete
                model: job.model,
                size: job.size,
                seconds: parseInt(job.seconds),
                prompt: formData.prompt,
                mode: 'create',
                costDetails,
                status: 'processing',
                progress: 0
            };

            setHistory((prev) => [newHistoryEntry, ...prev]);

            // Save active job IDs
            setActiveJobs((prev) => {
                const newJobs = new Map(prev).set(job.id, job);
                saveActiveJobIds(newJobs);
                return newJobs;
            });
            console.log(`Video ${job.id} added to history with queued status`);

            setIsSubmitting(false);
        } catch (err: unknown) {
            console.error('Error creating video:', err);
            if (err instanceof InvalidApiKeyError) {
                handleInvalidApiKey('The provided OpenAI API key was rejected. Please enter a valid key.');
            } else {
                const errorMessage = err instanceof Error ? err.message : 'An unexpected error occurred.';
                setError(errorMessage);
            }

            // Remove temporary job on error
            setActiveJobs((prev) => {
                const newJobs = new Map(prev);
                newJobs.delete(tempId);
                return newJobs;
            });
            setCurrentJobId(null);
            setIsSubmitting(false);
        }
    };

    const handleRemixVideo = async (formData: RemixFormData) => {
        setError(null);
        setIsSubmitting(true);

        // Backend mode: check password
        if (apiMode === 'backend' && isPasswordRequiredByBackend && !clientPasswordHash) {
            setError('Password is required. Please configure the password by clicking the lock icon.');
            setPasswordDialogContext('initial');
            setIsPasswordDialogOpen(true);
            setIsSubmitting(false);
            return;
        }

        // Frontend mode: check API key (shouldn't reach here with gate, but defensive)
        if (apiMode === 'frontend' && !clientApiKey) {
            setError('OpenAI API key is required for frontend mode.');
            setIsSubmitting(false);
            return;
        }

        // Create a temporary job to show immediate feedback
        const tempId = `temp_${Date.now()}`;
        const tempJob: VideoJob = {
            id: tempId,
            object: 'video',
            created_at: Date.now() / 1000,
            status: 'queued',
            model: 'sora-2', // We'll update this with actual model from API
            progress: 0,
            seconds: '4', // Will be updated with actual value
            size: '720x1280', // Will be updated with actual value
            prompt: formData.prompt,
            remix_of: formData.source_video_id
        };

        // Show temporary job immediately
        setActiveJobs((prev) => new Map(prev).set(tempId, tempJob));
        setCurrentJobId(tempId);

        try {
            console.log(`Creating remix for video: ${formData.source_video_id}`);

            const result = await videoService.remixVideo(formData.source_video_id, formData.prompt);

            console.log('Remix job created:', result);

            // Remove temporary job and add real job
            setActiveJobs((prev) => {
                const newJobs = new Map(prev);
                newJobs.delete(tempId);
                const job: VideoJob = {
                    ...result,
                    prompt: formData.prompt, // Store the remix prompt with the job
                    remix_of: formData.source_video_id // Preserve the source video reference
                };
                newJobs.set(job.id, job);
                return newJobs;
            });

            const job: VideoJob = {
                ...result,
                prompt: formData.prompt,
                remix_of: formData.source_video_id
            };
            setCurrentJobId(job.id);

            // Calculate cost immediately
            const costDetails =
                job.costDetails !== undefined
                    ? job.costDetails
                    : calculateVideoCost({
                          model: job.model,
                          size: job.size,
                          seconds: parseInt(job.seconds)
                      });

            // Add to history immediately with queued status
            const newHistoryEntry: VideoMetadata = {
                id: job.id,
                timestamp: Date.now(),
                filename: `${job.id}.mp4`,
                storageModeUsed: effectiveStorageModeClient,
                durationMs: 0, // Will be updated when complete
                model: job.model,
                size: job.size,
                seconds: parseInt(job.seconds),
                prompt: formData.prompt,
                mode: 'remix',
                costDetails,
                remix_of: formData.source_video_id,
                status: 'processing',
                progress: 0
            };

            setHistory((prev) => [newHistoryEntry, ...prev]);

            // Save active job IDs
            setActiveJobs((prev) => {
                const newJobs = new Map(prev).set(job.id, job);
                saveActiveJobIds(newJobs);
                return newJobs;
            });
            console.log(`Remix ${job.id} added to history with queued status`);

            setIsSubmitting(false);
        } catch (err: unknown) {
            console.error('Error creating remix:', err);
            if (err instanceof InvalidApiKeyError) {
                handleInvalidApiKey('The provided OpenAI API key was rejected. Please enter a valid key.');
            } else {
                const errorMessage = err instanceof Error ? err.message : 'An unexpected error occurred.';
                setError(errorMessage);
            }

            // Remove temporary job on error
            setActiveJobs((prev) => {
                const newJobs = new Map(prev);
                newJobs.delete(tempId);
                return newJobs;
            });
            setCurrentJobId(null);
            setIsSubmitting(false);
        }
    };

    const handleHistorySelect = (item: VideoMetadata) => {
        console.log(`Selecting video from history: ${item.id}`);
        setCurrentJobId(item.id);

        // If job is still active, it's already tracked
        if (activeJobs.has(item.id)) {
            return;
        }

        // Create a job entry for display based on the item's actual status
        const jobForDisplay: VideoJob = {
            id: item.id,
            object: 'video',
            created_at: item.timestamp,
            status: item.status === 'failed' ? 'failed' : 'completed',
            model: item.model,
            progress: item.status === 'failed' ? (item.progress || 0) : 100,
            seconds: toVideoSeconds(item.seconds),
            size: item.size,
            prompt: item.prompt,
            ...(item.error && { error: { message: item.error } }),
            ...(item.remix_of && { remix_of: item.remix_of })
        };

        setActiveJobs((prev) => new Map(prev).set(item.id, jobForDisplay));
    };

    const handleClearHistory = async () => {
        const confirmationMessage =
            effectiveStorageModeClient === 'indexeddb'
                ? 'Are you sure you want to clear the entire video history? This will delete all stored videos from your browser (IndexedDB) but will NOT delete them from OpenAI servers. This cannot be undone.'
                : effectiveStorageModeClient === 'r2'
                    ? 'Are you sure you want to clear the entire video history? This removes the entries from the shared database but keeps any files stored in R2. This cannot be undone.'
                    : 'Are you sure you want to clear the entire video history? This only clears your local history and does NOT delete videos from OpenAI servers. This cannot be undone.';

        if (window.confirm(confirmationMessage)) {
            setHistory([]);
            setCurrentJobId(null);
            setActiveJobs(new Map());
            setError(null);

            try {
                saveActiveJobIds(new Map());

                if (effectiveStorageModeClient === 'indexeddb') {
                    localStorage.removeItem('soraVideoHistory');
                    console.log('Cleared history metadata from localStorage.');

                    await db.videos.clear();
                    console.log('Cleared videos from IndexedDB.');
                    setVideoSrcCache(new Map());
                } else if (effectiveStorageModeClient === 'r2') {
                    const response = await fetch('/api/video-history', {
                        method: 'DELETE',
                        headers: clientPasswordHash ? { 'x-password-hash': clientPasswordHash } : {}
                    });

                    if (!response.ok) {
                        throw new Error('Failed to clear server-side history');
                    }
                }
            } catch (e) {
                console.error('Failed during history clearing:', e);
                setError(`Failed to clear history: ${e instanceof Error ? e.message : String(e)}`);
                if (isFrontendModeEnabled || apiMode === 'frontend') {
                    try {
                        const storedHistory = localStorage.getItem('soraVideoHistory');
                        if (storedHistory) {
                            const parsed: VideoMetadata[] = JSON.parse(storedHistory);
                            if (Array.isArray(parsed)) {
                                setHistory(parsed);
                            }
                        }
                } catch {
                    // ignore
                }
                } else {
                    await fetchHistory();
                }
            }
        }
    };

    const handleDeleteVideo = async (item: VideoMetadata, forceLocal = false) => {
        console.log(`Deleting video: ${item.id}${forceLocal ? ' (force local only)' : ''}`);
        setError(null);

        try {
            // Only delete from storage/OpenAI if video was actually created (not failed) and not force local
            if (item.status !== 'failed' && !forceLocal) {
                if (effectiveStorageModeClient === 'indexeddb') {
                    await db.videos.where('id').equals(item.id).delete();
                    setVideoSrcCache((prev) => {
                        const next = new Map(prev);
                        next.delete(item.id);
                        return next;
                    });
                    console.log('Deleted video from IndexedDB');
                } else {
                    // Delete from OpenAI via service (handles both backend and frontend modes)
                    try {
                        await videoService.deleteVideo(item.id);
                        console.log('Deleted video from OpenAI');
                    } catch (err: unknown) {
                        if (err instanceof InvalidApiKeyError) {
                            handleInvalidApiKey();
                            return;
                        }
                        // Handle "still processing" error with force delete option
                        if (err instanceof Error && err.message?.includes('still being processed')) {
                            setItemToForceDelete(item);
                            setForceDeleteDialogOpen(true);
                            return;
                        }
                        throw err;
                    }
                }
            } else {
                console.log(`Skipping storage/OpenAI deletion for ${item.status === 'failed' ? 'failed' : 'force local'} video ${item.id}`);
            }

            // Remove from history
            setHistory((prev) => prev.filter((v) => v.id !== item.id));

            // Clear if it's the current video
            if (currentJobId === item.id) {
                setCurrentJobId(null);
                setActiveJobs((prev) => {
                    const next = new Map(prev);
                    next.delete(item.id);
                    saveActiveJobIds(next);
                    return next;
                });
            }
        } catch (err) {
            if (err instanceof InvalidApiKeyError) {
                handleInvalidApiKey();
                return;
            }
            console.error('Error deleting video:', err);
            setError(err instanceof Error ? err.message : 'Failed to delete video');
        }
    };

    const handleForceDeleteConfirm = () => {
        if (itemToForceDelete) {
            handleDeleteVideo(itemToForceDelete, true);
        }
        setForceDeleteDialogOpen(false);
        setItemToForceDelete(null);
    };

    const handleForceDeleteCancel = () => {
        setForceDeleteDialogOpen(false);
        setItemToForceDelete(null);
    };

    const handleSendToRemix = (videoId: string) => {
        console.log(`Sending video to remix: ${videoId}`);
        setRemixSourceVideoId(videoId);
        setMode('remix');
    };

    const handleDownloadVideo = async (videoId: string) => {
        console.log(`Downloading video: ${videoId}`);
        try {
            const url = getVideoSrc(videoId);
            if (!url) {
                throw new Error('Video source not found');
            }

            // Create a download link
            const a = document.createElement('a');
            a.href = url;
            a.download = `${videoId}.mp4`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
        } catch (err) {
            console.error('Error downloading video:', err);
            setError(err instanceof Error ? err.message : 'Failed to download video');
        }
    };

    const currentJob = currentJobId ? activeJobs.get(currentJobId) : null;
    const currentVideoSrc = currentJobId ? getVideoSrc(currentJobId) : null;
    const currentThumbnailSrc = currentJobId ? getThumbnailSrc(currentJobId) : null;

    const completedVideos = history
        .filter((item) => {
            // Check if we have the video available
            const job = activeJobs.get(item.id);
            return !job || job.status === 'completed';
        })
        .map((item) => ({
            id: item.id,
            prompt: item.prompt,
            model: item.model,
            size: item.size,
            seconds: item.seconds
        }));

    // Determine if API key gate should block
    const isApiKeyGateBlocked = isFrontendModeEnabled && apiMode === 'frontend' && !clientApiKey;

    return (
        <main className='flex min-h-screen flex-col items-center bg-black p-4 text-white md:p-8 lg:p-12'>
            {!isFrontendModeEnabled && (
                <PasswordDialog
                    isOpen={isPasswordDialogOpen}
                    onOpenChange={setIsPasswordDialogOpen}
                    onSave={handleSavePassword}
                    isRequired={isPasswordRequiredByBackend === true && !clientPasswordHash}
                    title={passwordDialogContext === 'retry' ? 'Invalid Password' : 'Password Required'}
                    description={
                        passwordDialogContext === 'retry'
                            ? 'The password was incorrect. Please try again.'
                            : 'This application is password-protected. Please enter the password to continue.'
                    }
                />
            )}

            <ApiKeyDialog
                isOpen={isApiKeyDialogOpen}
                onOpenChange={setIsApiKeyDialogOpen}
                onSave={handleSaveApiKey}
            />

            <Dialog open={forceDeleteDialogOpen} onOpenChange={setForceDeleteDialogOpen}>
                <DialogContent className='border-neutral-700 bg-neutral-900 text-white sm:max-w-[450px]'>
                    <DialogHeader>
                        <DialogTitle className='flex items-center gap-2 text-white'>
                            <AlertCircle className='h-5 w-5 text-yellow-500' />
                            Video Still Processing
                        </DialogTitle>
                        <DialogDescription className='text-neutral-400'>
                            This video is still processing on OpenAI servers and cannot be deleted remotely yet.
                        </DialogDescription>
                    </DialogHeader>
                    <div className='py-4 text-sm text-neutral-300'>
                        <p>Would you like to force delete it from your local history?</p>
                        <p className='mt-3 text-xs text-neutral-400'>
                            ⚠️ This will remove it from your view, but it may still exist on OpenAI servers.
                        </p>
                    </div>
                    <DialogFooter className='gap-2'>
                        <Button
                            type='button'
                            variant='secondary'
                            onClick={handleForceDeleteCancel}
                            className='bg-neutral-700 text-neutral-200 hover:bg-neutral-600'>
                            Wait
                        </Button>
                        <Button
                            type='button'
                            onClick={handleForceDeleteConfirm}
                            className='bg-red-600 text-white hover:bg-red-700'>
                            Force Delete
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <div className='w-full max-w-7xl space-y-6'>
                <div className='grid grid-cols-1 gap-6 lg:grid-cols-2 lg:items-stretch'>
                    <div className='relative flex min-h-[600px] flex-col lg:col-span-1'>
                        <ApiKeyGate
                            isBlocked={isApiKeyGateBlocked}
                            onConfigure={handleOpenApiKeyDialog}
                            className='flex-1'>
                            {mode === 'create' ? (
                                <CreationForm
                                    onSubmit={handleCreateVideo}
                                    isLoading={isSubmitting}
                                    currentMode={mode}
                                    onModeChange={setMode}
                                    model={createModel}
                                    setModel={setCreateModel}
                                    prompt={createPrompt}
                                    setPrompt={setCreatePrompt}
                                    size={createSize}
                                    setSize={setCreateSize}
                                    seconds={createSeconds}
                                    setSeconds={setCreateSeconds}
                                    inputReference={createInputReference}
                                    setInputReference={setCreateInputReference}
                                />
                            ) : (
                                <RemixForm
                                    onSubmit={handleRemixVideo}
                                    isLoading={isSubmitting}
                                    currentMode={mode}
                                    onModeChange={setMode}
                                    sourceVideoId={remixSourceVideoId}
                                    setSourceVideoId={setRemixSourceVideoId}
                                    remixPrompt={remixPrompt}
                                    setRemixPrompt={setRemixPrompt}
                                    completedVideos={completedVideos}
                                    getVideoSrc={getVideoSrc}
                                />
                            )}
                        </ApiKeyGate>
                    </div>
                    <div className='flex min-h-[600px] flex-col lg:col-span-1'>
                        {error && (
                            <Alert variant='destructive' className='mb-4 border-red-500/50 bg-red-900/20 text-red-300'>
                                <AlertTitle className='text-red-200'>Error</AlertTitle>
                                <AlertDescription>{error}</AlertDescription>
                            </Alert>
                        )}
                        <VideoOutput
                            job={currentJob || null}
                            videoSrc={currentVideoSrc}
                            thumbnailSrc={currentThumbnailSrc}
                            isLoading={currentJob ? currentJob.status === 'queued' || currentJob.status === 'in_progress' : false}
                            onSendToRemix={handleSendToRemix}
                            onDownload={handleDownloadVideo}
                        />
                    </div>
                </div>

                <div className='min-h-[450px]'>
                    <VideoHistoryPanel
                        history={history}
                        activeJobs={activeJobs}
                        onSelectVideo={handleHistorySelect}
                        onClearHistory={handleClearHistory}
                        getVideoSrc={getVideoSrc}
                        getThumbnailSrc={getThumbnailSrc}
                        onDeleteItem={handleDeleteVideo}
                    />
                </div>
            </div>
        </main>
    );
}
