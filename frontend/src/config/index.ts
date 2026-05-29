// Single edge URL for all app traffic. In dev → Caddy in front of
// frontend+backend (.envrc:EDGE_URL). In staging/prod → Caddy on the bastion.
// Empty string is fine — relative URLs resolve to current origin, which is
// what we want when frontend and backend share an edge.
const BASE_URL = process.env.NEXT_PUBLIC_API_URL || ''

export const API_CONFIG = {
  BASE_URL,
  API_URL: `${BASE_URL}/api`,
  TIMEOUT: 30000,
  RETRY_ATTEMPTS: 3,
}

export const APP_CONFIG = {
  NAME: 'Piano',
  VERSION: '1.0.0',
}

export const AUTH_CONFIG = {
  SESSION_DURATION: 7 * 24 * 60 * 60 * 1000, // 7 days
  COOKIE_NAME: 'piano-auth',
}

// SSE shares the API edge — `/events` is proxied to backend by Caddy.
// Same BASE_URL on purpose; no separate NEXT_PUBLIC_SSE_URL.
export const SSE_CONFIG = {
  BASE_URL,
}

// Terminal traffic flows through the backend (`/api/terminal/:machineId`)
// which proxies to the right daemon. Daemons never need a public port. The
// env override below is a hatch for developers debugging against a direct
// daemon listener — when set, TerminalPanel uses that URL with the legacy
// `/ws?machineId=…` shape instead of the proxied backend route.
export const TERMINAL_CONFIG = {
  // WARNING: setting this bypasses backend auth — for local development only, never set in production
  DIRECT_DAEMON_URL: process.env.NEXT_PUBLIC_TERMINAL_DAEMON_URL || '',
}

