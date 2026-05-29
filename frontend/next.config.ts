import type { NextConfig } from 'next'
import path from 'path'

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3031'

const nextConfig: NextConfig = {
  // /etc/hosts aliases for running multiple dev instances simultaneously on the same machine.
  // See README "Edge host" section for setup instructions.
  allowedDevOrigins: [
    'piano.com', 'piano1.com', 'piano2.com', 'piano3.com', 'piano4.com', 'piano5.com',
  ],
  output: 'standalone',
  // Disabled because React strict mode's dev double-mount kills long-lived
  // WebSocket connections (xterm terminals) before they can establish.
  reactStrictMode: false,
  transpilePackages: ['@piano/shared'],
  eslint: {
    ignoreDuringBuilds: true,
  },
  turbopack: {
    root: path.resolve(__dirname, '..'),
    resolveAlias: {
      '@piano/shared': '../shared/src',
    },
  },
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: `${BACKEND_URL}/api/:path*`,
      },
    ]
  },
}

export default nextConfig