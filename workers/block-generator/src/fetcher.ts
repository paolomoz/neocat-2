import { BlockGeneratorError } from './types';

/**
 * Fetches HTML content from a URL
 */
export async function fetchPage(url: string): Promise<string> {
  // Validate URL format
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new BlockGeneratorError(
      `Invalid URL format: ${url}`,
      'INVALID_URL'
    );
  }

  // Only allow http/https protocols
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    throw new BlockGeneratorError(
      `Invalid protocol: ${parsedUrl.protocol}. Only http and https are allowed.`,
      'INVALID_URL'
    );
  }

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'EDS-Block-Generator/1.0 (Cloudflare Worker)',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
      cf: {
        // Cache for 5 minutes to avoid repeated fetches
        cacheTtl: 300,
        cacheEverything: false,
      },
    });

    if (!response.ok) {
      throw new BlockGeneratorError(
        `Failed to fetch URL: HTTP ${response.status} ${response.statusText}`,
        'FETCH_FAILED',
        502
      );
    }

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('text/html') && !contentType.includes('application/xhtml')) {
      throw new BlockGeneratorError(
        `URL did not return HTML content. Content-Type: ${contentType}`,
        'FETCH_FAILED'
      );
    }

    return await response.text();
  } catch (error) {
    if (error instanceof BlockGeneratorError) {
      throw error;
    }

    throw new BlockGeneratorError(
      `Network error fetching URL: ${error instanceof Error ? error.message : 'Unknown error'}`,
      'FETCH_FAILED',
      502
    );
  }
}
