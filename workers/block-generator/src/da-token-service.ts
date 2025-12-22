/**
 * Document Authoring IMS Token Service
 *
 * Manages authentication for Adobe Document Authoring API and AEM Admin API.
 * Uses service account (DA_CLIENT_ID, DA_CLIENT_SECRET, DA_SERVICE_TOKEN) for authentication.
 *
 * Tokens are cached in memory and refreshed on expiration (401 errors).
 */

import type { Env } from './types';

// Adobe IMS token endpoint for OAuth 2.0 authorization access token exchange
const IMS_TOKEN_ENDPOINT = 'https://ims-na1.adobelogin.com/ims/token/v3';

// Token cache for service account tokens
interface TokenCache {
  token: string;
  obtainedAt: number;
}

let cachedToken: TokenCache | null = null;

/**
 * Check if service account credentials are configured
 */
function hasServiceAccountConfig(env: Env): boolean {
  return !!(
    env.DA_CLIENT_ID &&
    env.DA_CLIENT_SECRET &&
    env.DA_SERVICE_TOKEN
  );
}

/**
 * Exchange Adobe IMS credentials for an access token using OAuth 2.0 authorization code flow
 */
async function exchangeForAccessToken(
  clientId: string,
  clientSecret: string,
  serviceToken: string
): Promise<string> {
  console.log('[DA Token] Exchanging IMS credentials for access token...');

  // Prepare form-encoded data (matching the working curl request)
  const formParams = new URLSearchParams();
  formParams.append('grant_type', 'authorization_code');
  formParams.append('client_id', clientId);
  formParams.append('client_secret', clientSecret);
  formParams.append('code', serviceToken);

  const response = await fetch(IMS_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: formParams.toString()
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('[DA Token] IMS token exchange failed', {
      status: response.status,
      endpoint: IMS_TOKEN_ENDPOINT,
      error: errorText
    });
    throw new Error(`Failed to exchange IMS credentials: ${response.status} - ${errorText}`);
  }

  const tokenData = await response.json() as { access_token?: string; expires_in?: number };

  if (!tokenData.access_token) {
    throw new Error('No access token received from IMS');
  }

  console.log('[DA Token] Successfully obtained access token from IMS', {
    expiresIn: tokenData.expires_in
  });
  return tokenData.access_token;
}

/**
 * Get DA authentication token
 * Priority:
 * 1. User's IMS token (from request/session) - if provided
 * 2. Service account token (with caching and refresh)
 * 3. Error if none available
 *
 * @param env - Cloudflare Worker environment bindings
 * @param userImsToken - Optional user's IMS token (e.g., from authenticated request header)
 */
export async function getDAToken(env: Env, userImsToken?: string): Promise<string> {
  // Priority 1: Use user's IMS token if provided
  if (userImsToken) {
    console.log('[DA Token] Using user-provided IMS token for DA operations');
    return userImsToken;
  }

  // Priority 2: Service account with cached token
  if (cachedToken) {
    const age = Date.now() - cachedToken.obtainedAt;
    const maxAge = 23 * 60 * 60 * 1000; // 23 hours (token expires in 24h, refresh before)

    if (age < maxAge) {
      console.log('[DA Token] Using cached service account IMS token');
      return cachedToken.token;
    } else {
      console.log('[DA Token] Cached token expired, refreshing');
      cachedToken = null;
    }
  }

  // Priority 2b: Service account - generate new token
  if (hasServiceAccountConfig(env)) {
    console.log('[DA Token] Generating new service account IMS token');
    const clientId = env.DA_CLIENT_ID!;
    const clientSecret = env.DA_CLIENT_SECRET!;
    const serviceToken = env.DA_SERVICE_TOKEN!;

    const accessToken = await exchangeForAccessToken(clientId, clientSecret, serviceToken);

    // Cache the token
    cachedToken = {
      token: accessToken,
      obtainedAt: Date.now()
    };

    return accessToken;
  }

  // No authentication configured
  throw new Error(
    'Document Authoring authentication not configured. ' +
    'Please configure DA service account credentials ' +
    '(DA_CLIENT_ID, DA_CLIENT_SECRET, DA_SERVICE_TOKEN).'
  );
}

/**
 * Clear cached token (called on authentication errors)
 */
export function clearCachedToken(): void {
  console.log('[DA Token] Clearing cached IMS token');
  cachedToken = null;
}

/**
 * Check if DA authentication is configured
 */
export function isDAConfigured(env: Env): boolean {
  return hasServiceAccountConfig(env);
}
