import { createAuthClient } from 'better-auth/client'
import { API_CONFIG } from '@/config';

export const authClient = createAuthClient({
  baseURL: API_CONFIG.BASE_URL,
  basePath: '/api/auth',
})
