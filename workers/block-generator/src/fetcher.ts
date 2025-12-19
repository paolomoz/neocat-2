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
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Cache-Control': 'no-cache',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Upgrade-Insecure-Requests': '1',
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
