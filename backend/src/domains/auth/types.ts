/**
 * Authentication Types Documentation
 * 
 * These types document the request/response structure for better-auth endpoints.
 * They are for developer reference only - better-auth handles these internally.
 */

// ============================================
// REQUEST TYPES
// ============================================

export namespace AuthRequest {
  /**
   * POST /api/auth/sign-up
   * Register a new user
   */
  export interface SignUp {
    email: string;
    password: string;
    name?: string;
  }

  /**
   * POST /api/auth/sign-in
   * Login with email/password
   */
  export interface SignIn {
    email: string;
    password: string;
  }

  /**
   * POST /api/auth/sign-out
   * No body required - uses session from Authorization header
   */
  export interface SignOut {
    // Empty - session handled via header
  }

  /**
   * POST /api/auth/refresh
   * Refresh access token using refresh token
   */
  export interface Refresh {
    refreshToken: string;
  }
}

// ============================================
// RESPONSE TYPES
// ============================================

export namespace AuthResponse {
  /**
   * User object returned in responses
   */
  export interface User {
    id: string;
    email: string;
    emailVerified: boolean;
    name: string | null;
    image: string | null;
    createdAt: string; // ISO date string
    updatedAt: string; // ISO date string
  }

  /**
   * Session object
   */
  export interface Session {
    id: string;
    userId: string;
    token: string; // The refresh token
    expiresAt: string; // ISO date string
    userAgent: string | null;
    ipAddress: string | null;
  }

  /**
   * POST /api/auth/sign-up response
   * Returns user, session, and tokens
   */
  export interface SignUp {
    user: User;
    session: {
      id: string;
      userId: string;
      expiresAt: string;
    };
    token: string;        // Access JWT token (short-lived, ~15 mins)
    refreshToken: string; // Refresh token (long-lived, 7 days)
  }

  /**
   * POST /api/auth/sign-in response
   * Same structure as sign-up
   */
  export interface SignIn {
    user: User;
    session: {
      id: string;
      userId: string;
      expiresAt: string;
    };
    token: string;        // Access JWT token
    refreshToken: string; // Refresh token
  }

  /**
   * POST /api/auth/sign-out response
   */
  export interface SignOut {
    success: boolean;
  }

  /**
   * GET /api/auth/session response
   * Returns current session if valid
   */
  export interface SessionCheck {
    user: User | null;
    session: Session | null;
  }

  /**
   * POST /api/auth/refresh response
   * Returns new access token
   */
  export interface Refresh {
    token: string;        // New access JWT token
    refreshToken: string; // Same or rotated refresh token
  }

  /**
   * Error response structure
   */
  export interface Error {
    error: {
      code: string; // e.g., "USER_ALREADY_EXISTS", "INVALID_CREDENTIALS"
      message: string;
    };
    statusCode: number;
  }
}

// ============================================
// USAGE NOTES
// ============================================

/**
 * Authentication Flow:
 * 
 * 1. SIGN UP:
 *    - Client sends: email, password, name (optional)
 *    - Server returns: user object, access token, refresh token
 *    - Client stores: access token in memory, refresh token in secure storage
 * 
 * 2. SIGN IN:
 *    - Client sends: email, password
 *    - Server returns: user object, access token, refresh token
 *    - Client stores tokens same as sign up
 * 
 * 3. AUTHENTICATED REQUESTS:
 *    - Client sends: Authorization: Bearer <access_token>
 *    - If 401 response, use refresh token to get new access token
 * 
 * 4. TOKEN REFRESH:
 *    - Client sends: refresh token
 *    - Server returns: new access token (and possibly rotated refresh token)
 *    - Client updates stored tokens
 * 
 * 5. SIGN OUT:
 *    - Client sends: request with Authorization header
 *    - Server invalidates session in database
 *    - Client clears stored tokens
 * 
 * Token Lifetimes:
 * - Access Token: ~15 minutes (stateless JWT)
 * - Refresh Token: 7 days (stored in database)
 * 
 * Security Notes:
 * - Access tokens are stateless JWTs - cannot be revoked
 * - Refresh tokens are stored in DB - can be revoked
 * - Always use HTTPS in production
 * - Store refresh token securely (httpOnly cookie or secure storage)
 */