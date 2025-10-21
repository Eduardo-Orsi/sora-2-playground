import type { NextConfig } from 'next';

const isFrontendMode = process.env.NEXT_PUBLIC_ENABLE_FRONTEND_MODE === 'true';
const isGitHubPages = process.env.GITHUB_PAGES === 'true';

const nextConfig: NextConfig = {
  output: 'standalone',
  ...(isFrontendMode
    ? {
        output: 'export' as const,
        images: {
          unoptimized: true,
        },
        ...(isGitHubPages && {
          basePath: '/sora-2-playground',
          assetPrefix: '/sora-2-playground/',
        }),
      }
    : {}),
};

export default nextConfig;
