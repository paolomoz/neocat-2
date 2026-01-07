import {
  BlockRequest,
  BlockResponse,
  ErrorResponse,
  BlockGeneratorError,
  Env,
  GitHubPushRequest,
  GitHubPushResponse,
  DACreatePageRequest,
  DACreatePageResponse,
  BlockVariantPushRequest,
  BlockVariantPushResponse,
  BlockVariant,
  BlockFinalizeRequest,
  BlockFinalizeResponse,
  BlockCleanupRequest,
  BlockCleanupResponse,
  GitHubConfig,
  DAConfig,
  DesignSystemImportRequest,
  DesignSystemImportResponse,
} from './types';
import {
  extractComputedStyles as extractDesignComputedStyles,
  parseStylesheets,
  downloadFonts,
  analyzeDesignWithClaude,
  mergeExtractedDesign,
  generateStylesCSS,
  generateStyleGuideCSS,
  generateFontsCSS,
  generateFallbackFonts,
} from './design-system-extractor';
import { generateStyleGuideHTML } from './style-guide-template';
import { fetchPage } from './fetcher';
import { parseHTMLDocument, getElement } from './parser';
import { extractContent } from './content-extractor';
import { buildBlock } from './block-builder';
import { captureElementScreenshot, extractLiveImages, ExtractedImage } from './screenshot';
import { analyzeDesign, generateBlockCode, analyzePageBlocks, nameDetectedBlocks, DesignTokens, AnthropicConfig, GeneratedBlockCode, IdentifiedBlock, NamedBlock } from './design-analyzer';
import { detectBlocksInBrowser, DetectedBlock, PageDetectionResult } from './block-detector';
import { detectBlocksVisually, VisualDetectionResult } from './visual-block-detector';
import { detectBlocksAnnotated, AnnotatedDetectionResult } from './annotated-detector';
import { detectBlocksSmart, SmartDetectionResult } from './smart-detector';
import { generateBlockEnhanced, EnhancedBlockCode } from './enhanced-generator';
import { extractComputedStyles, formatStylesForPrompt } from './style-extractor';
import { detectBlocks, captureBlockScreenshot, DetectedBlock as BBoxBlock, BoundingBox } from './bbox-detector';
import { detectBlocksHybrid, ClassifiedBlock, HybridDetectionResult } from './hybrid-detector';
import { analyzePage, PageAnalysisResult, IdentifiedSection } from './page-analyzer';
import { refineBlock, renderBlockToScreenshot, BlockCode } from './block-refiner';
import { getDAToken, clearCachedToken } from './da-token-service';
import puppeteer, { Page } from '@cloudflare/puppeteer';

/**
 * Convert ArrayBuffer to base64 string without stack overflow
 * Uses chunked approach to handle large files
 */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 8192;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    binary += String.fromCharCode.apply(null, Array.from(chunk));
  }
  return btoa(binary);
}

/**
 * Compress a large image using Puppeteer canvas
 * Claude has a 5MB limit, so we resize images > 4MB to be safe
 * Returns { data: base64, mediaType: 'image/png' | 'image/jpeg' }
 */
async function compressImageIfNeeded(
  browser: ReturnType<typeof puppeteer.launch> extends Promise<infer T> ? T : never,
  base64Image: string,
  maxSizeBytes: number = 4 * 1024 * 1024 // 4MB default
): Promise<{ data: string; mediaType: 'image/png' | 'image/jpeg' }> {
  // Calculate approximate size (base64 is ~33% larger than binary)
  const base64Length = base64Image.length;
  const approxSize = (base64Length * 3) / 4;

  console.log(`Checking image size: base64 length=${base64Length}, approx binary=${(approxSize / 1024 / 1024).toFixed(2)}MB, threshold=${(maxSizeBytes / 1024 / 1024).toFixed(2)}MB`);

  if (approxSize <= maxSizeBytes) {
    console.log('Image within size limit, no compression needed');
    return { data: base64Image, mediaType: 'image/png' }; // No compression needed
  }

  console.log(`Image too large (${(approxSize / 1024 / 1024).toFixed(2)}MB), compressing...`);

  const page = await browser.newPage();
  try {
    // Calculate scale factor to get under the size limit
    const scaleFactor = Math.sqrt(maxSizeBytes / approxSize) * 0.9; // 0.9 for safety margin

    const compressedBase64 = await page.evaluate(async (imgData: string, scale: number) => {
      return new Promise<string>((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement('canvas');
          const newWidth = Math.floor(img.width * scale);
          const newHeight = Math.floor(img.height * scale);
          canvas.width = newWidth;
          canvas.height = newHeight;

          const ctx = canvas.getContext('2d');
          if (!ctx) {
            reject(new Error('Could not get canvas context'));
            return;
          }

          ctx.drawImage(img, 0, 0, newWidth, newHeight);
          // Use JPEG for better compression on photos
          const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
          resolve(dataUrl.split(',')[1]); // Return just the base64 part
        };
        img.onerror = () => reject(new Error('Failed to load image'));
        img.src = 'data:image/png;base64,' + imgData;
      });
    }, base64Image, scaleFactor);

    const newSize = (compressedBase64.length * 3) / 4;
    console.log(`Compressed image to ${(newSize / 1024 / 1024).toFixed(2)}MB`);

    return { data: compressedBase64, mediaType: 'image/jpeg' };
  } finally {
    await page.close();
  }
}

/**
 * Capture screenshot from a URL (e.g., EDS preview URL)
 * Waits for page to load and captures viewport
 */
async function captureUrlScreenshot(
  browser: Browser,
  url: string,
  viewport: { width: number; height: number }
): Promise<string> {
  const page = await browser.newPage();
  try {
    await page.setViewport(viewport);
    await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });

    // Wait a bit for any JS decoration to complete
    await new Promise(r => setTimeout(r, 1000));

    // Take screenshot
    const screenshotBuffer = await page.screenshot({ type: 'png' }) as Buffer;
    return screenshotBuffer.toString('base64');
  } finally {
    await page.close();
  }
}

/**
 * Dismiss cookie consent banners before taking screenshots
 * Uses multiple strategies: click buttons, text matching, CSS hiding
 */
async function dismissCookieBanners(page: Page): Promise<void> {
  console.log('Dismissing cookie consent banners...');

  // Strategy 1: Try common button selectors
  const commonSelectors = [
    '#onetrust-accept-btn-handler',
    '.onetrust-close-btn-handler',
    '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
    '#CybotCookiebotDialogBodyButtonAccept',
    '.trustarc-agree-btn',
    '.qc-cmp2-summary-buttons button[mode="primary"]',
    '[class*="cookie"] [class*="accept"]',
    '[class*="cookie"] [class*="agree"]',
    '[class*="consent"] [class*="accept"]',
    '[class*="consent"] [class*="agree"]',
    '[class*="gdpr"] [class*="accept"]',
    '.cc-accept',
    '.cc-allow',
    '.cc-btn.cc-dismiss',
  ];

  for (const selector of commonSelectors) {
    try {
      const button = await page.$(selector);
      if (button) {
        const isVisible = await button.isIntersectingViewport();
        if (isVisible) {
          await button.click();
          await new Promise(r => setTimeout(r, 500));
          console.log(`Dismissed cookie banner via: ${selector}`);
          return;
        }
      }
    } catch {
      // Continue to next selector
    }
  }

  // Strategy 2: Find buttons by text content
  const dismissed = await page.evaluate(() => {
    const acceptTexts = [
      'accept all', 'accept cookies', 'accept', 'agree to all', 'agree',
      'allow all', 'allow cookies', 'allow', 'i agree', 'i accept',
      'got it', 'ok', 'continue', 'dismiss'
    ];

    const bannerSelectors = [
      '[class*="cookie"]', '[class*="consent"]', '[class*="gdpr"]',
      '[class*="privacy"]', '[id*="cookie"]', '[id*="consent"]',
      '[role="dialog"]', '[role="alertdialog"]'
    ];

    for (const containerSelector of bannerSelectors) {
      const containers = document.querySelectorAll(containerSelector);
      for (const container of containers) {
        const rect = container.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;

        const clickables = container.querySelectorAll('button, a, [role="button"], [class*="btn"]');
        for (const el of clickables) {
          const text = (el.textContent || '').toLowerCase().trim();
          for (const acceptText of acceptTexts) {
            if (text === acceptText || text.includes(acceptText)) {
              (el as HTMLElement).click();
              return true;
            }
          }
        }
      }
    }
    return false;
  });

  if (dismissed) {
    await new Promise(r => setTimeout(r, 500));
    console.log('Dismissed cookie banner via text matching');
    return;
  }

  // Strategy 3: Hide cookie banners via CSS injection
  await page.evaluate(() => {
    const style = document.createElement('style');
    style.textContent = `
      [class*="cookie-banner"], [class*="cookie-consent"], [class*="cookie-notice"],
      [class*="gdpr-banner"], [class*="consent-banner"], [class*="privacy-banner"],
      [class*="cookie-disclaimer"], [class*="cookies-disclaimer"],
      [id*="cookie-banner"], [id*="cookie-consent"], [id*="gdpr"],
      .cc-banner, .cc-window, #onetrust-banner-sdk, #CybotCookiebotDialog,
      [class*="CookieConsent"], [class*="cookieConsent"],
      [class*="cookie-policy"], [class*="cookie-popup"],
      [aria-label*="cookie"], [aria-label*="consent"],
      [role="dialog"][class*="cookie"], [role="alertdialog"][class*="cookie"] {
        display: none !important;
        visibility: hidden !important;
        opacity: 0 !important;
        pointer-events: none !important;
      }
    `;
    document.head.appendChild(style);
  });
  console.log('Applied CSS to hide cookie banners');
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return handleCORS(env);
    }

    const url = new URL(request.url);

    // Health check endpoint
    if (url.pathname === '/health' && request.method === 'GET') {
      return Response.json({ status: 'ok', version: '1.0.0' });
    }

    // Test UI endpoint
    if (url.pathname === '/' && request.method === 'GET') {
      return handleTestUI(env);
    }

    // Batch generation UI
    if (url.pathname === '/batch' && request.method === 'GET') {
      return handleBatchUI(env);
    }

    // Debug: View bbox screenshots
    if (url.pathname === '/debug/bboxes' && request.method === 'POST') {
      return handleDebugBboxes(request, env);
    }

    // Debug: View section extraction for Y-boundaries
    if (url.pathname === '/debug/section' && request.method === 'POST') {
      return handleDebugSection(request, env);
    }

    // Analyze page to identify blocks
    if (url.pathname === '/analyze' && request.method === 'POST') {
      return handleAnalyze(request, env);
    }

    // Compose page from sections and push to DA
    if (url.pathname === '/compose-page' && request.method === 'POST') {
      return handleComposePage(request, env);
    }

    // Finalize page import (merge branch to main)
    if (url.pathname === '/page-finalize' && request.method === 'POST') {
      return handlePageFinalize(request, env);
    }

    // Generate a single block for a page import section (standalone workflow)
    if (url.pathname === '/generate-block-for-section' && request.method === 'POST') {
      return handleGenerateBlockForSection(request, env);
    }

    // Main generation endpoint (JSON response)
    if (url.pathname === '/generate' && request.method === 'POST') {
      return handleGenerate(request, env);
    }

    // Preview endpoint (HTML page for browser)
    if (url.pathname === '/preview' && request.method === 'POST') {
      return handlePreview(request, env);
    }

    // Block generate endpoint (multipart form data with screenshot + HTML)
    if (url.pathname === '/block-generate' && request.method === 'POST') {
      return handleBlockGenerate(request, env);
    }

    // Block generate full endpoint (initial + refinements in single browser session)
    if (url.pathname === '/block-generate-full' && request.method === 'POST') {
      return handleBlockGenerateFull(request, env);
    }

    // Block refine endpoint (iterative refinement with pixelmatch)
    if (url.pathname === '/block-refine' && request.method === 'POST') {
      return handleBlockRefine(request, env);
    }

    // Block winner endpoint (select best option using Claude Vision)
    if (url.pathname === '/block-winner' && request.method === 'POST') {
      return handleBlockWinner(request, env);
    }

    // Block GitHub endpoint (push block code to GitHub repo)
    if (url.pathname === '/block-github' && request.method === 'POST') {
      return handleBlockGitHub(request, env);
    }

    // Block DA endpoint (create page in DA Admin)
    if (url.pathname === '/block-da' && request.method === 'POST') {
      return handleBlockDA(request, env);
    }

    // EDS Preview Flow endpoints
    if (url.pathname === '/block-variant-push' && request.method === 'POST') {
      return handleBlockVariantPush(request, env);
    }

    if (url.pathname === '/block-finalize' && request.method === 'POST') {
      return handleBlockFinalize(request, env);
    }

    if (url.pathname === '/block-cleanup' && request.method === 'POST') {
      return handleBlockCleanup(request, env);
    }

    if (url.pathname === '/session-id' && request.method === 'GET') {
      return Response.json({ sessionId: generateSessionId() }, { headers: corsHeaders(env) });
    }

    // Design System Import endpoint
    if (url.pathname === '/design-system-import' && request.method === 'POST') {
      return handleDesignSystemImport(request, env);
    }

    // Design System Finalize endpoint (merge branch to main)
    if (url.pathname === '/design-system-finalize' && request.method === 'POST') {
      return handleDesignSystemFinalize(request, env);
    }

    // Debug endpoint to check config
    if (url.pathname === '/debug-config' && request.method === 'GET') {
      return Response.json({
        ANTHROPIC_USE_BEDROCK: env.ANTHROPIC_USE_BEDROCK,
        ANTHROPIC_USE_BEDROCK_type: typeof env.ANTHROPIC_USE_BEDROCK,
        ANTHROPIC_AWS_BEARER_TOKEN_BEDROCK_exists: !!env.ANTHROPIC_AWS_BEARER_TOKEN_BEDROCK,
        ANTHROPIC_AWS_BEARER_TOKEN_BEDROCK_length: env.ANTHROPIC_AWS_BEARER_TOKEN_BEDROCK?.length || 0,
        ANTHROPIC_AWS_REGION: env.ANTHROPIC_AWS_REGION,
        ANTHROPIC_API_KEY_exists: !!env.ANTHROPIC_API_KEY,
        configResult: getAnthropicConfig(env) ? 'configured' : 'undefined',
      });
    }

    // Test UI for block-generate and block-refine
    if (url.pathname === '/test' && request.method === 'GET') {
      return handleBlockTestUI(env);
    }

    // 404 for unknown routes
    return Response.json(
      { success: false, error: 'Not found', code: 'NOT_FOUND' },
      { status: 404, headers: corsHeaders(env) }
    );
  },
};

/**
 * Build Anthropic config from environment
 */
function getAnthropicConfig(env: Env): AnthropicConfig | undefined {
  // Debug logging
  console.log('getAnthropicConfig called');
  console.log('  ANTHROPIC_USE_BEDROCK:', env.ANTHROPIC_USE_BEDROCK, 'type:', typeof env.ANTHROPIC_USE_BEDROCK);
  console.log('  ANTHROPIC_AWS_BEARER_TOKEN_BEDROCK exists:', !!env.ANTHROPIC_AWS_BEARER_TOKEN_BEDROCK);
  console.log('  ANTHROPIC_API_KEY exists:', !!env.ANTHROPIC_API_KEY);

  // Check for Bedrock config
  if (env.ANTHROPIC_USE_BEDROCK === '1' && env.ANTHROPIC_AWS_BEARER_TOKEN_BEDROCK) {
    console.log('  Using Bedrock config with model:', env.ANTHROPIC_MODEL_OPUS || 'default');
    return {
      useBedrock: true,
      bedrockToken: env.ANTHROPIC_AWS_BEARER_TOKEN_BEDROCK,
      bedrockRegion: env.ANTHROPIC_AWS_REGION || 'us-east-1',
      bedrockModel: env.ANTHROPIC_MODEL_OPUS,
    };
  }

  // Check for direct Anthropic API key
  if (env.ANTHROPIC_API_KEY) {
    console.log('  Using direct API key');
    return {
      apiKey: env.ANTHROPIC_API_KEY,
    };
  }

  console.log('  No Anthropic config found!');
  return undefined;
}

/**
 * Launch browser with retry logic for session errors
 */
async function launchBrowserWithRetry(
  browserBinding: any,
  maxRetries: number = 3,
  delayMs: number = 1000
): Promise<ReturnType<typeof puppeteer.launch>> {
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const browser = await puppeteer.launch(browserBinding);
      return browser;
    } catch (error) {
      lastError = error as Error;
      const errorMessage = lastError.message || '';

      // Check if it's a session connection error (retryable)
      if (errorMessage.includes('Unable to connect to existing session') ||
          errorMessage.includes('Target closed') ||
          errorMessage.includes('not ready yet')) {
        console.log(`Browser launch attempt ${attempt}/${maxRetries} failed, retrying in ${delayMs}ms...`);
        if (attempt < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, delayMs));
          continue;
        }
      }

      // Non-retryable error, throw immediately
      throw error;
    }
  }

  // All retries exhausted
  throw lastError || new Error('Failed to launch browser after retries');
}

/**
 * Capture screenshot and analyze design using Claude Vision (legacy - extracts tokens only)
 */
async function analyzeDesignFromScreenshot(
  url: string,
  selector: string,
  env: Env
): Promise<DesignTokens | undefined> {
  const anthropicConfig = getAnthropicConfig(env);
  if (!anthropicConfig || !env.BROWSER) {
    return undefined;
  }

  try {
    const browser = await puppeteer.launch(env.BROWSER);
    try {
      const { screenshot } = await captureElementScreenshot(browser, url, selector);
      const designTokens = await analyzeDesign(screenshot, anthropicConfig);
      return designTokens;
    } finally {
      await browser.close();
    }
  } catch (error) {
    console.error('Design analysis failed:', error);
    return undefined;
  }
}

/**
 * Generate block from Y-boundaries
 * Extracts actual DOM content, crops screenshot, extracts CSS - then generates with real data
 */
async function generateBlockFromDescription(
  url: string,
  sectionDescription: string,
  sectionName: string,
  env: Env,
  yStart: number = 0,
  yEnd: number = 0,
  maxRetries: number = 3
): Promise<EnhancedBlockCode | undefined> {
  const anthropicConfig = getAnthropicConfig(env);
  if (!anthropicConfig || !env.BROWSER) {
    return undefined;
  }

  let lastError: Error | undefined;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const browser = await puppeteer.launch(env.BROWSER);
      try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1440, height: 900 });
        // Set desktop user agent to ensure desktop layout
        await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await new Promise(resolve => setTimeout(resolve, 2000));

        // Dismiss cookie consent banners before screenshots
        try {
          await dismissCookieBanners(page);
        } catch (e) {
          console.log('Cookie dismissal error:', e);
        }

        // Scroll to load lazy content (same as analysis phase)
        await page.evaluate(async () => {
          const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
          const scrollHeight = document.documentElement.scrollHeight;
          const viewportHeight = window.innerHeight;
          const scrollStep = viewportHeight * 0.8;
          let currentPosition = 0;
          while (currentPosition < scrollHeight) {
            window.scrollTo(0, currentPosition);
            await delay(150);
            currentPosition += scrollStep;
          }
          window.scrollTo(0, scrollHeight);
          await delay(300);
          window.scrollTo(0, 0);
        });
        await new Promise(resolve => setTimeout(resolve, 1000));

        // Get page dimensions after scroll
        const dimensions = await page.evaluate(() => ({
          width: document.documentElement.scrollWidth,
          height: document.documentElement.scrollHeight,
        }));

        console.log(`Page loaded: ${dimensions.width}x${dimensions.height}`);
        console.log(`Looking for section at Y: ${yStart}-${yEnd}`);

        // Find the DOM element at the Y position and extract its content
        const sectionData = await page.evaluate((yS: number, yE: number) => {
          const targetHeight = yE - yS;

          // First, scroll to bring the section into view
          window.scrollTo(0, Math.max(0, yS - 100));

          // Find elements that intersect with our Y range
          const allElements = document.querySelectorAll('body *');
          const candidates: { el: Element; score: number; elTop: number; elHeight: number }[] = [];

          for (const el of allElements) {
            const rect = el.getBoundingClientRect();
            const elTop = rect.top + window.scrollY;
            const elBottom = elTop + rect.height;

            // Skip tiny elements, scripts, styles, etc.
            if (rect.width < 100 || rect.height < 30) continue;
            if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'META', 'LINK', 'BR', 'HR'].includes(el.tagName)) continue;

            // Check overlap with target Y range
            const overlapStart = Math.max(yS, elTop);
            const overlapEnd = Math.min(yE, elBottom);
            const overlap = Math.max(0, overlapEnd - overlapStart);

            if (overlap > 0) {
              // Score based on how well the element MATCHES the target range (not just overlaps)
              const rangeCoverage = overlap / targetHeight; // How much of target is covered (want ~1.0)

              // CRITICAL: Penalize elements that don't match target size
              // Both too-large AND too-small elements should be penalized
              const sizeRatio = rect.height / targetHeight;
              let sizePenalty = 1;
              if (sizeRatio > 2) {
                // Too large: penalize proportionally
                sizePenalty = Math.max(0.2, 1 / Math.sqrt(sizeRatio));
              } else if (sizeRatio < 0.5) {
                // Too small: also penalize - element doesn't contain full section
                sizePenalty = Math.max(0.3, sizeRatio * 1.5);
              }

              // CRITICAL: Boundary matching - element should START and END near target
              const startDiff = Math.abs(elTop - yS) / targetHeight;
              const endDiff = Math.abs(elBottom - yE) / targetHeight;
              // Strong penalty if element doesn't start/end near target boundaries
              const boundaryPenalty = Math.max(0.3, 1 - (startDiff + endDiff) * 0.4);

              // Base score: coverage * size fit * boundary fit
              let score = rangeCoverage * sizePenalty * boundaryPenalty;

              // Bonus for semantic section elements
              const isSection = ['SECTION', 'ARTICLE', 'MAIN'].includes(el.tagName);
              if (isSection) score *= 1.15;

              // Bonus for elements with meaningful classes (not generic divs)
              const hasClasses = el.classList.length > 0;
              if (hasClasses && !['SECTION', 'ARTICLE', 'MAIN'].includes(el.tagName)) {
                score *= 1.05;
              }

              candidates.push({ el, score, elTop, elHeight: rect.height });
            }
          }

          if (candidates.length === 0) {
            return null;
          }

          // Sort by score descending
          candidates.sort((a, b) => b.score - a.score);

          // Get best candidate
          let bestElement = candidates[0].el;
          let bestScore = candidates[0].score;

          // If best candidate is much larger than target, look for better children
          const bestRect = bestElement.getBoundingClientRect();
          if (bestRect.height > targetHeight * 2.5) {
            // Try to find a direct child that fits better
            const children = bestElement.children;
            for (const child of children) {
              const childRect = child.getBoundingClientRect();
              const childTop = childRect.top + window.scrollY;
              const childBottom = childTop + childRect.height;

              // Check if child overlaps with target
              const childOverlapStart = Math.max(yS, childTop);
              const childOverlapEnd = Math.min(yE, childBottom);
              const childOverlap = Math.max(0, childOverlapEnd - childOverlapStart);

              if (childOverlap > targetHeight * 0.5 && childRect.height < bestRect.height * 0.8) {
                // This child is a better fit
                const childRangeCoverage = childOverlap / targetHeight;
                const childElementCoverage = childOverlap / childRect.height;
                const childSizeRatio = childRect.height / targetHeight;
                const childSizePenalty = childSizeRatio > 2 ? Math.max(0.1, 1 / childSizeRatio) : 1;
                const childScore = (childRangeCoverage * 0.4 + childElementCoverage * 0.4) * childSizePenalty;

                if (childScore > bestScore * 0.7) { // Accept if reasonably close
                  bestElement = child;
                  bestScore = childScore;
                  break;
                }
              }
            }
          }

          // Get the element's bounding box for screenshot cropping
          const rect = bestElement.getBoundingClientRect();
          const bbox = {
            x: 0, // Full width
            y: rect.top + window.scrollY,
            width: document.documentElement.scrollWidth,
            height: rect.height,
          };

          // Extract the actual HTML content
          const html = bestElement.outerHTML;

          // Extract text content for reference
          const textContent = bestElement.textContent?.trim().substring(0, 2000) || '';

          // Find all images within this section
          const images: { src: string; alt: string }[] = [];
          const imgElements = bestElement.querySelectorAll('img');
          imgElements.forEach(img => {
            const src = img.src || img.dataset.src || img.getAttribute('data-lazy-src') || '';
            if (src && !src.startsWith('data:')) {
              images.push({ src, alt: img.alt || '' });
            }
          });

          // CRITICAL: Check background-image on the element ITSELF first
          const elStyle = window.getComputedStyle(bestElement);
          const elBgImage = elStyle.backgroundImage;
          if (elBgImage && elBgImage !== 'none' && elBgImage.includes('url(')) {
            const match = elBgImage.match(/url\(['"]?([^'"]+)['"]?\)/);
            if (match && match[1] && !match[1].startsWith('data:')) {
              images.push({ src: match[1], alt: 'background' });
            }
          }

          // Also get background images from child elements
          const bgElements = bestElement.querySelectorAll('*');
          bgElements.forEach(el => {
            const style = window.getComputedStyle(el);
            const bgImage = style.backgroundImage;
            if (bgImage && bgImage !== 'none' && bgImage.includes('url(')) {
              const match = bgImage.match(/url\(['"]?([^'"]+)['"]?\)/);
              if (match && match[1] && !match[1].startsWith('data:')) {
                images.push({ src: match[1], alt: 'background' });
              }
            }
          });

          return {
            html,
            textContent,
            images,
            bbox,
            selector: bestElement.tagName.toLowerCase() +
              (bestElement.id ? `#${bestElement.id}` : '') +
              (bestElement.classList.length > 0 ? `.${Array.from(bestElement.classList).join('.')}` : ''),
            debugInfo: {
              score: bestScore,
              elTop: rect.top + window.scrollY,
              elHeight: rect.height,
              candidateCount: candidates.length,
            }
          };
        }, yStart, yEnd);

        if (!sectionData) {
          console.error('Could not find DOM element at Y position');
          return undefined;
        }

        console.log(`Found element: ${sectionData.selector}`);
        console.log(`  Element Y: ${Math.round(sectionData.debugInfo.elTop)}-${Math.round(sectionData.debugInfo.elTop + sectionData.debugInfo.elHeight)}px (height: ${Math.round(sectionData.debugInfo.elHeight)}px)`);
        console.log(`  Target Y: ${yStart}-${yEnd}px (height: ${yEnd - yStart}px)`);
        console.log(`  Score: ${(sectionData.debugInfo.score * 100).toFixed(1)}%, Candidates: ${sectionData.debugInfo.candidateCount}`);
        console.log(`Extracted ${sectionData.images.length} images`);
        if (sectionData.images.length > 0) {
          sectionData.images.slice(0, 3).forEach(img => console.log(`  - ${img.alt}: ${img.src.substring(0, 80)}...`));
        }
        console.log(`HTML length: ${sectionData.html.length} chars`);

        // Scroll to the element and take a cropped screenshot
        const bbox = sectionData.bbox;
        const screenshotHeight = Math.min(bbox.height, 2000); // Limit screenshot height

        let sectionScreenshot: string;
        try {
          const screenshotBuffer = await page.screenshot({
            clip: {
              x: 0,
              y: Math.max(0, bbox.y),
              width: Math.min(dimensions.width, 1440),
              height: screenshotHeight,
            },
            type: 'png',
          }) as Buffer;
          sectionScreenshot = screenshotBuffer.toString('base64');
          console.log(`Captured section screenshot: ${dimensions.width}x${screenshotHeight}`);
        } catch (e) {
          console.error('Failed to capture section screenshot:', e);
          // Fallback to viewport screenshot
          const viewportBuffer = await page.screenshot({ type: 'png' }) as Buffer;
          sectionScreenshot = viewportBuffer.toString('base64');
        }

        await page.close();

        // Generate block with actual extracted content
        console.log(`Generating block for: ${sectionName}`);
        const block = await generateBlockFromDescriptionWithClaude(
          sectionScreenshot,
          sectionDescription,
          sectionName,
          url,
          sectionData.images.map(img => ({ src: img.src, role: img.alt || 'image' })),
          sectionData.html,
          anthropicConfig
        );

        return block;
      } finally {
        await browser.close();
      }
    } catch (error) {
      lastError = error as Error;
      const errorMsg = lastError.message || '';

      if (errorMsg.includes('429') || errorMsg.includes('Rate limit')) {
        const delay = Math.pow(2, attempt) * 2000;
        console.log(`Rate limited, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }

      console.error('Description-based generation failed:', error);
      return undefined;
    }
  }

  console.error('Generation failed after retries:', lastError);
  return undefined;
}

/**
 * Use Claude to generate block from extracted content and screenshot
 * Claude receives the actual HTML content and must use it - not invent content
 */
async function generateBlockFromDescriptionWithClaude(
  screenshotBase64: string,
  sectionDescription: string,
  sectionName: string,
  baseUrl: string,
  liveImages: { src: string; role: string }[],
  extractedHtml: string,
  config: AnthropicConfig
): Promise<EnhancedBlockCode> {
  // Build numbered image reference list - Claude references by index, we inject real URLs
  const imageRefList = liveImages.length > 0
    ? `\n\n## AVAILABLE IMAGES (use ONLY these by reference number):
${liveImages.map((img, i) => `[IMG_${i + 1}] - ${img.role}`).join('\n')}

CRITICAL: When you need an image, use data-img-ref attribute:
  <img data-img-ref="1" alt="description">
DO NOT write src="..." - real URLs will be injected automatically.
DO NOT invent or guess image URLs.`
    : '';

  // Truncate HTML if too long but keep structure visible
  const htmlPreview = extractedHtml.length > 15000
    ? extractedHtml.substring(0, 15000) + '\n... [truncated]'
    : extractedHtml;

  const prompt = `You are converting a webpage section to an AEM Edge Delivery Services (EDS) block.

## YOUR TASK
Look at this screenshot of the section and the extracted HTML below.
Generate an EDS block that recreates this EXACT section with the EXACT same content.

SECTION NAME: ${sectionName}
DESCRIPTION: ${sectionDescription}

## CRITICAL RULES - YOU MUST FOLLOW THESE

1. **USE THE EXACT TEXT from the extracted HTML** - Do NOT invent, paraphrase, or modify any text content
2. **IMAGES: Use data-img-ref="N" ONLY** - reference images by [IMG_N] number, NO src attribute
3. **MATCH THE VISUAL DESIGN** from the screenshot - colors, fonts, layout, spacing
4. The generated block MUST contain the same content as the original - same headings, same paragraphs, same links
5. **NO WRAPPER BACKGROUNDS** - Do NOT add background-color to .{block-name}-wrapper selectors. EDS wraps blocks automatically. Only style the block element itself and its children.
6. **BUTTON COLORS**: Extract the EXACT button background-color from the HTML/CSS. DO NOT guess colors from screenshots - use the actual hex values from inline styles or class definitions in the extracted HTML.
7. **ABSOLUTELY NO BLOCK-LEVEL BACKGROUNDS** - This is MANDATORY: NEVER add background-color, background, or any background styling to the block container (.{block-name}) or section. The section's background (whether light blue, green, gray, etc.) is controlled by section metadata in AEM, NOT by block CSS. If you add a background to the block, it will BREAK the design. Only internal elements like cards may have backgrounds (e.g., .card-item { background: #fff; }).

## EXTRACTED HTML FROM THE PAGE (this is the actual content - use it!)

\`\`\`html
${htmlPreview}
\`\`\`
${imageRefList}

## EDS Block Requirements

EDS blocks have this **authoring structure** (what authors see in DA):
\`\`\`html
<div class="{block-name}">
  <div><!-- row 1 -->
    <div><!-- cell 1: content --></div>
    <div><!-- cell 2: content --></div>
  </div>
</div>
\`\`\`

The JS **decorate(block)** function transforms this simple structure into the **rendered DOM**:
\`\`\`javascript
export default function decorate(block) {
  // Read content from the simple row/cell structure
  // Build the rich rendered HTML with wrapper elements, classes, etc.
  // Replace block.innerHTML with the rendered structure
}
\`\`\`

The **CSS** styles the **rendered output** (what decorate() produces), NOT the authoring HTML.

## What You Need to Generate

1. **HTML**: Simple EDS authoring structure with rows/cells containing the content (text, images via data-img-ref="N")
2. **JS**: decorate(block) that reads the simple structure and builds the rendered DOM matching the screenshot
3. **CSS**: Styles targeting the rendered DOM structure that decorate() creates

## CSS Guidelines

- Style ONLY the block class and its children: .{block-name}, .{block-name} .child-element
- NEVER style -wrapper or -container selectors (EDS adds these automatically)
- **CRITICAL - NO BLOCK BACKGROUNDS**:
  * NEVER add background-color or background to .{block-name} selector
  * The colored section background you see in the screenshot is NOT part of the block - it's section metadata
  * If the section appears light blue, light green, gray, etc. - IGNORE IT, do not replicate it in CSS
  * Your block CSS must work on ANY background color
  * Use background: transparent; or simply OMIT any background property on the block
- The ONLY exception for backgrounds: internal card/item elements inside the block (e.g., .card-item { background: #fff; })

## Return Format

Return JSON:
{
  "blockName": "descriptive-block-name",
  "componentType": "hero|cards|columns|tabs|content|etc",
  "html": "<!-- EDS block - use data-img-ref for images -->",
  "css": "/* CSS for .{block-name} and children ONLY - no wrapper styles */",
  "js": "/* ES module: export default function decorate(block) { ... } */"
}

REMEMBER: Use data-img-ref="N" for images. Do NOT write src attributes.

Return ONLY the JSON object.`;

  const response = await callClaudeForGeneration(screenshotBase64, prompt, config, 12000);

  try {
    let jsonStr: string | null = null;
    const codeBlockMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlockMatch) {
      jsonStr = codeBlockMatch[1].trim();
    } else {
      const jsonMatch = response.match(/\{[\s\S]*"blockName"[\s\S]*\}/);
      if (jsonMatch) jsonStr = jsonMatch[0];
    }

    if (!jsonStr) throw new Error('No JSON found in response');

    const parsed = JSON.parse(jsonStr);

    // Post-process to inject real image URLs
    let html = parsed.html || '';
    if (liveImages.length > 0) {
      html = injectImageUrlsIntoHtml(html, liveImages);
    }

    return {
      blockName: parsed.blockName || 'generated-block',
      componentType: parsed.componentType || 'content',
      html,
      css: parsed.css || '',
      js: parsed.js || '',
      description: {
        componentType: parsed.componentType || 'content',
        structure: { layout: '', contentHierarchy: [] },
        design: { colorScheme: '', textStyle: '', spacing: '' },
        contentElements: { headings: [], paragraphs: [], images: [], ctas: [] },
      },
    };
  } catch (e) {
    console.error('Failed to parse generation response:', response.substring(0, 500));
    throw new Error('Failed to parse generation response');
  }
}

/**
 * Inject real image URLs into HTML by replacing data-img-ref attributes
 */
function injectImageUrlsIntoHtml(
  html: string,
  images: { src: string; role: string }[]
): string {
  if (!images.length) return html;

  let result = html;
  let injectedCount = 0;

  // Replace data-img-ref="N" with src="actual-url"
  result = result.replace(
    /<img([^>]*?)data-img-ref=["'](\d+)["']([^>]*?)>/gi,
    (match, before, refNum, after) => {
      const index = parseInt(refNum, 10) - 1;
      if (index >= 0 && index < images.length) {
        const img = images[index];
        injectedCount++;
        const cleanBefore = before.replace(/\s*src=["'][^"']*["']/gi, '');
        const cleanAfter = after.replace(/\s*src=["'][^"']*["']/gi, '');
        return `<img${cleanBefore} src="${img.src}"${cleanAfter}>`;
      }
      console.warn(`Image reference ${refNum} out of bounds (have ${images.length} images)`);
      return match;
    }
  );

  // Fallback: replace placeholder src values with real URLs
  const usedIndices = new Set<number>();
  let unusedImageIndex = 0;
  result = result.replace(
    /<img([^>]*?)src=["']([^"']*)["']([^>]*?)>/gi,
    (match, before, currentSrc, after) => {
      if (images.some(img => img.src === currentSrc)) return match;
      if (currentSrc.startsWith('http') &&
          !currentSrc.includes('placeholder') &&
          !currentSrc.includes('example.com')) {
        return match;
      }
      while (unusedImageIndex < images.length && usedIndices.has(unusedImageIndex)) {
        unusedImageIndex++;
      }
      if (unusedImageIndex < images.length) {
        const img = images[unusedImageIndex];
        usedIndices.add(unusedImageIndex);
        unusedImageIndex++;
        injectedCount++;
        console.log(`Replaced placeholder "${currentSrc}" with "${img.src}"`);
        return `<img${before} src="${img.src}"${after}>`;
      }
      return match;
    }
  );

  console.log(`Injected ${injectedCount} image URLs into generated HTML`);
  return result;
}

/**
 * Call Claude API for generation
 */
async function callClaudeForGeneration(
  imageBase64: string,
  prompt: string,
  config: AnthropicConfig,
  maxTokens: number = 4096
): Promise<string> {
  let response: Response;

  if (config.useBedrock && config.bedrockToken) {
    const region = config.bedrockRegion || 'us-east-1';
    const model = config.bedrockModel || 'anthropic.claude-sonnet-4-20250514-v1:0';
    const bedrockUrl = `https://bedrock-runtime.${region}.amazonaws.com/model/${encodeURIComponent(model)}/invoke`;

    response = await fetch(bedrockUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.bedrockToken}`,
      },
      body: JSON.stringify({
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens: maxTokens,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: imageBase64 } },
              { type: 'text', text: prompt },
            ],
          },
        ],
      }),
    });
  } else if (config.apiKey) {
    response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': config.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: maxTokens,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: imageBase64 } },
              { type: 'text', text: prompt },
            ],
          },
        ],
      }),
    });
  } else {
    throw new Error('No Anthropic API configuration provided');
  }

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Claude API error: ${response.status} - ${error}`);
  }

  const result = await response.json() as {
    content: Array<{ type: string; text?: string }>;
  };

  const textContent = result.content.find(c => c.type === 'text');
  if (!textContent?.text) {
    throw new Error('No text response from Claude');
  }

  return textContent.text;
}

/**
 * Enhanced block generation using the describe-first approach:
 * 1. Extract computed CSS styles from the live page
 * 2. Describe component (structure, design)
 * 3. Extract content guided by description
 * 4. Generate code with full context including real CSS values
 */
async function generateBlockFromScreenshotEnhanced(
  url: string,
  selector: string,
  elementHtml: string,
  env: Env,
  maxRetries: number = 3
): Promise<EnhancedBlockCode | undefined> {
  const anthropicConfig = getAnthropicConfig(env);
  if (!anthropicConfig || !env.BROWSER) {
    return undefined;
  }

  let lastError: Error | undefined;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const browser = await puppeteer.launch(env.BROWSER);
      try {
        // Create a page to reuse for multiple operations
        const page = await browser.newPage();
        await page.setViewport({ width: 1440, height: 900 });
        await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });

        console.log(`Capturing screenshot for selector: ${selector}`);
        await page.waitForSelector(selector, { timeout: 10000 });
        const element = await page.$(selector);
        if (!element) {
          throw new Error(`Element not found: ${selector}`);
        }
        const screenshotBuffer = await element.screenshot({ type: 'png', encoding: 'base64' });
        const boundingBox = await element.boundingBox();
        const screenshot = screenshotBuffer as string;
        console.log(`Screenshot captured: ${boundingBox?.width}x${boundingBox?.height}, base64 length: ${screenshot.length}`);

        // Extract live images from the rendered page (includes lazy-loaded and CSS background images)
        let liveImages: ExtractedImage[] = [];
        try {
          console.log('Extracting live images from rendered page...');
          liveImages = await extractLiveImages(page, selector, url);
          console.log(`Found ${liveImages.length} live images`);
        } catch (imgError) {
          console.warn('Live image extraction failed:', imgError);
        }

        // Extract computed styles from the live page
        let extractedCssStyles: string | undefined;
        try {
          console.log('Extracting computed CSS styles...');
          const styles = await extractComputedStyles(browser, url, selector);
          extractedCssStyles = formatStylesForPrompt(styles);
          console.log(`Extracted styles for: container, ${styles.cards.length} cards, ${styles.headings.length} headings`);
        } catch (styleError) {
          console.warn('Style extraction failed, continuing without:', styleError);
        }

        await page.close();

        const generatedBlock = await generateBlockEnhanced(screenshot, elementHtml, url, anthropicConfig, extractedCssStyles, liveImages);
        return generatedBlock;
      } finally {
        await browser.close();
      }
    } catch (error) {
      lastError = error as Error;
      const errorMsg = lastError.message || '';

      // Check if it's a rate limit error (429)
      if (errorMsg.includes('429') || errorMsg.includes('Rate limit')) {
        const delay = Math.pow(2, attempt) * 2000; // 2s, 4s, 8s
        console.log(`Browser rate limited, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }

      // For other errors, don't retry
      console.error('Enhanced block generation failed:', error);
      return undefined;
    }
  }

  console.error('Enhanced block generation failed after retries:', lastError);
  return undefined;
}

/**
 * Legacy: Capture screenshot and generate complete block code using Claude Vision
 * Includes retry logic for Browser Rendering rate limits
 */
async function generateBlockFromScreenshot(
  url: string,
  selector: string,
  extracted: ReturnType<typeof extractContent>,
  env: Env,
  maxRetries: number = 3
): Promise<GeneratedBlockCode | undefined> {
  const anthropicConfig = getAnthropicConfig(env);
  if (!anthropicConfig || !env.BROWSER) {
    return undefined;
  }

  let lastError: Error | undefined;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const browser = await puppeteer.launch(env.BROWSER);
      try {
        const { screenshot } = await captureElementScreenshot(browser, url, selector);
        const generatedBlock = await generateBlockCode(screenshot, extracted, anthropicConfig);
        return generatedBlock;
      } finally {
        await browser.close();
      }
    } catch (error) {
      lastError = error as Error;
      const errorMsg = lastError.message || '';

      // Check if it's a rate limit error (429)
      if (errorMsg.includes('429') || errorMsg.includes('Rate limit')) {
        const delay = Math.pow(2, attempt) * 2000; // 2s, 4s, 8s
        console.log(`Browser rate limited, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }

      // For other errors, don't retry
      console.error('Block code generation failed:', error);
      return undefined;
    }
  }

  console.error('Block code generation failed after retries:', lastError);
  return undefined;
}

/**
 * Generate block from bounding box coordinates (new simplified approach)
 * 1. Navigate to page
 * 2. Capture screenshot of bounding box region
 * 3. Extract HTML from that region
 * 4. Generate block code
 */
async function generateBlockFromBoundingBox(
  url: string,
  bbox: BoundingBox,
  env: Env
): Promise<EnhancedBlockCode | undefined> {
  const anthropicConfig = getAnthropicConfig(env);
  if (!anthropicConfig || !env.BROWSER) {
    return undefined;
  }

  try {
    const browser = await puppeteer.launch(env.BROWSER);
    try {
      const page = await browser.newPage();
      await page.setViewport({ width: 1440, height: 900 });
      await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });

      // Capture screenshot of just the bounding box region
      console.log(`Capturing screenshot for bbox: ${bbox.x},${bbox.y} ${bbox.width}x${bbox.height}`);
      const screenshotBuffer = await page.screenshot({
        clip: {
          x: bbox.x,
          y: bbox.y,
          width: bbox.width,
          height: bbox.height,
        },
        type: 'png',
      }) as Buffer;
      const screenshot = screenshotBuffer.toString('base64');
      console.log(`Screenshot captured: ${bbox.width}x${bbox.height}, base64 length: ${screenshot.length}`);

      // Extract HTML from the bounding box region
      const html = await page.evaluate((box: BoundingBox) => {
        // Find element at center of bounding box
        const centerX = box.x + box.width / 2;
        const centerY = box.y + box.height / 2;

        // Scroll to position
        window.scrollTo(0, Math.max(0, box.y - 100));

        const element = document.elementFromPoint(
          centerX - window.scrollX,
          Math.min(centerY - window.scrollY + 100, window.innerHeight - 10)
        );

        if (!element) return null;

        // Walk up to find best container
        let current: Element | null = element;
        let best = element;

        while (current && current !== document.body) {
          const rect = current.getBoundingClientRect();
          const elBox = {
            x: rect.left + window.scrollX,
            y: rect.top + window.scrollY,
            width: rect.width,
            height: rect.height,
          };

          // Check overlap with target box
          const overlapX = Math.max(0, Math.min(elBox.x + elBox.width, box.x + box.width) - Math.max(elBox.x, box.x));
          const overlapY = Math.max(0, Math.min(elBox.y + elBox.height, box.y + box.height) - Math.max(elBox.y, box.y));
          const overlapRatio = (overlapX * overlapY) / (box.width * box.height);

          if (overlapRatio > 0.6) {
            best = current;
          }

          if (elBox.width > box.width * 2 || elBox.height > box.height * 2) break;
          current = current.parentElement;
        }

        return best.outerHTML;
      }, bbox);

      if (!html) {
        console.error('Could not extract HTML from bounding box');
        return undefined;
      }

      console.log(`Extracted ${html.length} chars of HTML`);

      // Generate block using enhanced generator
      const generatedBlock = await generateBlockEnhanced(screenshot, html, url, anthropicConfig);
      return generatedBlock;
    } finally {
      await browser.close();
    }
  } catch (error) {
    console.error('Bounding box generation failed:', error);
    return undefined;
  }
}

/**
 * Handles the page analysis request - identifies blocks on a page
 * Uses visual-first approach (like identify-page-structure skill):
 * 1. Take full page screenshot
 * 2. Claude identifies visual sections with Y-boundaries
 * 3. Map Y-boundaries to DOM elements
 */
async function handleAnalyze(request: Request, env: Env): Promise<Response> {
  try {
    const contentType = request.headers.get('content-type') || '';

    if (!contentType.includes('application/json')) {
      return Response.json(
        { success: false, error: 'Content-Type must be application/json', code: 'INVALID_REQUEST' },
        { status: 400, headers: corsHeaders(env) }
      );
    }

    const body = await request.json() as { url?: string };
    const url = body?.url;

    if (typeof url !== 'string' || !url.trim()) {
      return Response.json(
        { success: false, error: 'Missing or invalid "url" field', code: 'INVALID_REQUEST' },
        { status: 400, headers: corsHeaders(env) }
      );
    }

    // Check if Browser Rendering is available
    if (!env.BROWSER) {
      return Response.json(
        { success: false, error: 'Browser Rendering not configured', code: 'CONFIG_ERROR' },
        { status: 500, headers: corsHeaders(env) }
      );
    }

    const anthropicConfig = getAnthropicConfig(env);

    if (!anthropicConfig) {
      return Response.json(
        { success: false, error: 'Claude API not configured - required for block detection', code: 'CONFIG_ERROR' },
        { status: 500, headers: corsHeaders(env) }
      );
    }

    // Visual-first detection (like identify-page-structure skill):
    // 1. Take full-page screenshot
    // 2. Claude identifies visual sections with descriptions
    // No CSS selectors - generator will use descriptions to locate sections
    let browser;
    try {
      browser = await puppeteer.launch(env.BROWSER);
      const page = await browser.newPage();
      const result = await analyzePage(page, url.trim(), anthropicConfig);

      // Return sections with descriptions and Y-boundaries for generation
      return Response.json(
        {
          success: true,
          url: url.trim(),
          title: result.title,
          blocks: result.sections.map(s => ({
            index: s.index,
            name: s.name,
            description: s.description,
            type: s.type,
            priority: s.priority,
            style: s.style,
            yStart: s.yStart,
            yEnd: s.yEnd,
          })),
          screenshot: result.screenshot,
          pageWidth: result.pageWidth,
          pageHeight: result.pageHeight,
        },
        { status: 200, headers: corsHeaders(env) }
      );
    } finally {
      if (browser) await browser.close();
    }
  } catch (error) {
    console.error('Page analysis failed:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return Response.json(
      { success: false, error: message, code: 'ANALYSIS_ERROR' },
      { status: 500, headers: corsHeaders(env) }
    );
  }
}

/**
 * Infer a basic block name from detected content
 */
function inferBlockName(block: DetectedBlock): string {
  if (block.classes.some(c => c.includes('hero') || c.includes('banner'))) {
    return 'Hero Section';
  }
  if (block.classes.some(c => c.includes('carousel') || c.includes('slider'))) {
    return 'Carousel';
  }
  if (block.classes.some(c => c.includes('card'))) {
    return 'Cards Section';
  }
  if (block.hasImages && block.hasHeadings) {
    return 'Content Section';
  }
  if (block.hasImages) {
    return 'Media Section';
  }
  if (block.hasHeadings) {
    return 'Text Section';
  }
  return 'Content Block';
}

/**
 * Infer block type from detected content
 */
function inferBlockType(block: DetectedBlock): NamedBlock['type'] {
  const classStr = block.classes.join(' ').toLowerCase();
  if (classStr.includes('hero') || classStr.includes('banner')) return 'hero';
  if (classStr.includes('carousel') || classStr.includes('slider')) return 'carousel';
  if (classStr.includes('card')) return 'cards';
  if (classStr.includes('column') || classStr.includes('grid')) return 'columns';
  if (classStr.includes('tab')) return 'tabs';
  if (classStr.includes('accordion') || classStr.includes('faq')) return 'accordion';
  if (classStr.includes('form')) return 'form';
  return 'content';
}

/**
 * Handles the block generation request
 * Supports both bounding box (new) and selector (legacy) approaches
 */
async function handleGenerate(request: Request, env: Env): Promise<Response> {
  try {
    const body = await parseRequestBody(request);

    let blockName: string;
    let blockHtml: string;
    let blockJs: string;
    let blockCss: string;
    let componentType: string | undefined;

    // NEW: Bounding box approach (preferred)
    if (body.boundingBox) {
      console.log('Using bounding box approach');
      const enhancedBlock = await generateBlockFromBoundingBox(body.url, body.boundingBox, env);

      if (!enhancedBlock) {
        return Response.json(
          { success: false, error: 'Block generation failed', code: 'GENERATION_FAILED' },
          { status: 500, headers: corsHeaders(env) }
        );
      }

      blockName = enhancedBlock.blockName;
      blockHtml = enhancedBlock.html;
      blockJs = enhancedBlock.js;
      blockCss = enhancedBlock.css;
      componentType = enhancedBlock.componentType;
    }
    // LEGACY: Selector approach
    else if (body.selector) {
      console.log('Using selector approach (legacy)');
      const html = await fetchPage(body.url);
      const document = parseHTMLDocument(html);
      const element = getElement(document, body.selector);

      let combinedHtml = element.outerHTML;
      if (body.siblingSelectors && body.siblingSelectors.length > 0) {
        const siblingHtmlParts: string[] = [];
        for (const sibSel of body.siblingSelectors) {
          try {
            const sibEl = getElement(document, sibSel);
            siblingHtmlParts.push(sibEl.innerHTML);
          } catch (e) {
            console.log(`Could not get sibling element: ${sibSel}`);
          }
        }
        if (siblingHtmlParts.length > 0) {
          combinedHtml = `<div class="merged-content">${element.innerHTML}${siblingHtmlParts.join('')}</div>`;
        }
      }

      const extracted = extractContent(combinedHtml, body.url);
      const enhancedBlock = await generateBlockFromScreenshotEnhanced(body.url, body.selector, combinedHtml, env);

      if (enhancedBlock) {
        blockName = enhancedBlock.blockName;
        blockHtml = enhancedBlock.html;
        blockJs = enhancedBlock.js;
        blockCss = enhancedBlock.css;
        componentType = enhancedBlock.componentType;
      } else {
        const legacyBlock = await generateBlockFromScreenshot(body.url, body.selector, extracted, env);
        if (legacyBlock) {
          blockName = legacyBlock.blockName;
          blockHtml = legacyBlock.html;
          blockJs = legacyBlock.js;
          blockCss = legacyBlock.css;
        } else {
          const block = buildBlock(extracted);
          blockName = block.blockName;
          blockHtml = block.html;
          blockJs = block.js;
          blockCss = block.css;
        }
      }
    } else {
      return Response.json(
        { success: false, error: 'Either boundingBox or selector is required', code: 'INVALID_REQUEST' },
        { status: 400, headers: corsHeaders(env) }
      );
    }

    const response: BlockResponse = {
      success: true,
      blockName,
      layoutPattern: componentType as any || 'unknown',
      html: blockHtml,
      js: blockJs,
      css: blockCss,
      metadata: {
        elementCount: 0,
        hasImages: true,
        hasHeadings: true,
        hasLinks: true,
        rowCount: 1,
        columnCount: 1,
      },
    };

    return Response.json(response, { status: 200, headers: corsHeaders(env) });
  } catch (error) {
    return handleError(error, env);
  }
}

/**
 * Compose page from section selections and push to DA
 */
interface ComposePageSection {
  name: string;
  type: string;
  description: string;
  yStart: number;
  yEnd: number;
  blockChoice: string; // existing block name or '__generate__'
}

interface AcceptedBlockInfo {
  blockName: string;
  branch: string;
  sessionId: string;
}

interface ComposePageRequest {
  url: string;
  sections: ComposePageSection[];
  pageTitle?: string;
  sessionId: string;
  acceptedBlocks?: Record<number, AcceptedBlockInfo>; // sectionIndex -> block info from standalone workflow
  github: { owner: string; repo: string };
  da: { org: string; site: string };
}

async function handleComposePage(request: Request, env: Env): Promise<Response> {
  try {
    const contentType = request.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      return Response.json(
        { success: false, error: 'Content-Type must be application/json' },
        { status: 400, headers: corsHeaders(env) }
      );
    }

    const body = await request.json() as ComposePageRequest;

    // Validate required fields
    if (!body.url || !body.sections || !body.sessionId || !body.da?.org || !body.da?.site) {
      return Response.json(
        { success: false, error: 'Missing required fields: url, sections, sessionId, da.org, da.site' },
        { status: 400, headers: corsHeaders(env) }
      );
    }

    // GitHub info is required for creating page-import branch
    const githubToken = body.github?.token || env.GITHUB_TOKEN;
    if (!body.github?.owner || !body.github?.repo) {
      return Response.json(
        { success: false, error: 'Missing required fields: github.owner, github.repo' },
        { status: 400, headers: corsHeaders(env) }
      );
    }

    console.log(`Composing page from ${body.sections.length} sections for ${body.url}`);

    // Create page-import branch from main
    const pageBranch = `page-${body.sessionId}`;
    const githubFetch = createGitHubFetcher(githubToken);

    console.log(`Creating page-import branch: ${pageBranch}`);
    await ensureBranchExists(githubFetch, body.github.owner, body.github.repo, pageBranch, 'main');

    // Track accepted blocks that need to be copied to page branch
    const acceptedBlocksMap: Map<number, { blockName: string }> = new Map();

    // Copy accepted blocks from their preview branches to the page branch
    if (body.acceptedBlocks && Object.keys(body.acceptedBlocks).length > 0) {
      console.log(`Copying ${Object.keys(body.acceptedBlocks).length} accepted blocks to page branch...`);

      for (const [indexStr, blockInfo] of Object.entries(body.acceptedBlocks)) {
        const index = parseInt(indexStr, 10);
        const { blockName, branch } = blockInfo;

        console.log(`Copying block ${blockName} from branch ${branch} to ${pageBranch}`);

        try {
          // Get JS and CSS files from the accepted block's branch
          const jsContent = await getFileFromBranch(
            githubFetch,
            body.github.owner,
            body.github.repo,
            branch,
            `blocks/${blockName}/${blockName}.js`
          );

          const cssContent = await getFileFromBranch(
            githubFetch,
            body.github.owner,
            body.github.repo,
            branch,
            `blocks/${blockName}/${blockName}.css`
          );

          if (jsContent && cssContent) {
            // Push the block files to the page branch
            await pushFilesToBranch(
              githubFetch,
              body.github.owner,
              body.github.repo,
              pageBranch,
              [
                { path: `blocks/${blockName}/${blockName}.js`, content: jsContent },
                { path: `blocks/${blockName}/${blockName}.css`, content: cssContent },
              ],
              `Add ${blockName} block for page import ${body.sessionId}`
            );

            acceptedBlocksMap.set(index, { blockName });
            console.log(`Block ${blockName} copied successfully`);
          } else {
            console.warn(`Could not find block files for ${blockName} on branch ${branch}`);
          }
        } catch (copyError) {
          console.error(`Failed to copy block ${blockName}:`, copyError);
        }
      }

      console.log(`Block copying complete: ${acceptedBlocksMap.size}/${Object.keys(body.acceptedBlocks).length} blocks copied`);
    }

    // Launch browser to extract actual content from sections
    let browser;
    try {
      browser = await puppeteer.launch(env.BROWSER);
      const page = await browser.newPage();
      await page.setViewport({ width: 1440, height: 900 });

      console.log('Loading source page for content extraction...');
      await page.goto(body.url, { waitUntil: 'networkidle0', timeout: 30000 });

      // Dismiss cookie banners
      await dismissCookieBanners(page);
      await new Promise(r => setTimeout(r, 1000));

      // Extract content for each section based on Y-coordinates
      const sectionsHtml: string[] = [];

      for (let i = 0; i < body.sections.length; i++) {
        const section = body.sections[i];
        console.log(`Extracting content for section ${i + 1}: ${section.name} (Y: ${section.yStart}-${section.yEnd})`);

        // Extract actual HTML content from the section's Y-range
        const sectionContent = await page.evaluate((yStart: number, yEnd: number) => {
          const elements: Element[] = [];
          const allElements = document.querySelectorAll('body *');

          allElements.forEach(el => {
            const rect = el.getBoundingClientRect();
            const scrollY = window.scrollY;
            const elTop = rect.top + scrollY;
            const elBottom = rect.bottom + scrollY;

            // Check if element is within the Y-range and is a meaningful content element
            if (elTop >= yStart && elBottom <= yEnd) {
              const tagName = el.tagName.toLowerCase();
              // Only collect top-level content elements, not nested ones
              if (['section', 'article', 'div', 'header', 'footer', 'nav', 'main'].includes(tagName)) {
                // Check if this is a direct child or reasonably top-level
                const parent = el.parentElement;
                if (parent && !elements.includes(parent)) {
                  elements.push(el);
                }
              }
            }
          });

          // If we found section-level elements, use the largest one
          if (elements.length > 0) {
            // Sort by content size and get the most comprehensive one
            elements.sort((a, b) => b.innerHTML.length - a.innerHTML.length);
            const bestElement = elements[0];

            // Extract and clean the HTML
            const clone = bestElement.cloneNode(true) as HTMLElement;

            // Remove scripts and styles
            clone.querySelectorAll('script, style, noscript').forEach(el => el.remove());

            // Convert images to absolute URLs
            clone.querySelectorAll('img').forEach(img => {
              const src = img.getAttribute('src');
              if (src && !src.startsWith('http') && !src.startsWith('data:')) {
                img.setAttribute('src', new URL(src, window.location.href).href);
              }
            });

            // Convert links to absolute URLs
            clone.querySelectorAll('a').forEach(a => {
              const href = a.getAttribute('href');
              if (href && !href.startsWith('http') && !href.startsWith('#') && !href.startsWith('mailto:')) {
                a.setAttribute('href', new URL(href, window.location.href).href);
              }
            });

            return clone.innerHTML;
          }

          return null;
        }, section.yStart, section.yEnd);

        let blockHtml: string;
        // Use accepted block name if available, otherwise fall back to choice or derived name
        let blockName: string;
        if (section.blockChoice === '__generate__') {
          const accepted = acceptedBlocksMap.get(i);
          blockName = accepted?.blockName || (section.type || section.name.toLowerCase().replace(/\s+/g, '-')).replace(/[^a-z0-9-]/g, '');
        } else {
          blockName = section.blockChoice;
        }

        if (sectionContent) {
          // Wrap extracted content in a block table
          blockHtml = `
      <table>
        <tr><th colspan="2">${blockName}</th></tr>
        <tr>
          <td>${sectionContent}</td>
        </tr>
      </table>`;
        } else {
          // Fallback: create block with description if extraction failed
          console.warn(`Could not extract content for section: ${section.name}`);
          blockHtml = `
      <table>
        <tr><th colspan="2">${blockName}</th></tr>
        <tr>
          <td>
            <p><strong>${section.name}</strong></p>
            <p>${section.description || ''}</p>
          </td>
        </tr>
      </table>`;
        }

        sectionsHtml.push(`    <div>${blockHtml}
    </div>`);
      }

      // Compose full page HTML
      const pageTitle = body.pageTitle || new URL(body.url).pathname.split('/').pop() || 'imported-page';
      const pageHtml = `<body>
  <header></header>
  <main>
${sectionsHtml.join('\n    <hr>\n')}
  </main>
  <footer></footer>
</body>`;

      await browser.close();

      console.log('Generated page HTML:', pageHtml.substring(0, 500) + '...');

      // Get DA token
      let daToken: string | null = null;
      if (env.DA_CLIENT_ID && env.DA_CLIENT_SECRET && env.DA_SERVICE_TOKEN) {
        daToken = await exchangeDACredentialsForToken(
          env.DA_CLIENT_ID,
          env.DA_CLIENT_SECRET,
          env.DA_SERVICE_TOKEN
        );
      }

      if (!daToken) {
        return Response.json(
          { success: false, error: 'DA service account not configured' },
          { status: 500, headers: corsHeaders(env) }
        );
      }

      // Determine DA path from URL - include sessionId for isolation
      const urlPath = new URL(body.url).pathname;
      const pageName = urlPath.replace(/\.html$/, '').replace(/\/$/, '').replace(/^\//, '') || 'index';
      const daPath = `/drafts/imports/${body.sessionId}/${pageName}`;

      // Push to DA
      const daUrl = `https://admin.da.live/source/${body.da.org}/${body.da.site}${daPath}.html`;
      console.log('Pushing to DA:', daUrl);

      const formData = new FormData();
      formData.append('data', new Blob([pageHtml], { type: 'text/html' }));

      const daResponse = await fetch(daUrl, {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${daToken}` },
        body: formData,
      });

      if (!daResponse.ok) {
        const errorText = await daResponse.text();
        console.error('DA push failed:', daResponse.status, errorText);
        return Response.json(
          { success: false, error: `DA push failed: ${daResponse.status}` },
          { status: 500, headers: corsHeaders(env) }
        );
      }

      console.log('DA push successful');

      // Trigger AEM preview via admin API - use page branch for code
      const previewUrl = `https://${pageBranch}--${body.da.site}--${body.da.org}.aem.page${daPath}`;
      const aemPreviewApiUrl = `https://admin.hlx.page/preview/${body.github.owner}/${body.github.repo}/${pageBranch}${daPath}`;

      try {
        console.log('Triggering AEM preview:', aemPreviewApiUrl);
        let previewResponse = await fetch(aemPreviewApiUrl, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${daToken}` },
        });

        // Retry with fresh token if auth failed
        if (previewResponse.status === 401) {
          const freshToken = await exchangeDACredentialsForToken(
            env.DA_CLIENT_ID!,
            env.DA_CLIENT_SECRET!,
            env.DA_SERVICE_TOKEN!
          );
          previewResponse = await fetch(aemPreviewApiUrl, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${freshToken}` },
          });
        }

        console.log('AEM preview response:', previewResponse.status);
      } catch (previewError) {
        console.warn('AEM preview trigger failed (non-fatal):', previewError);
      }

      return Response.json({
        success: true,
        previewUrl,
        daPath,
        branch: pageBranch,
        sectionsProcessed: body.sections.length,
        blocksCopied: acceptedBlocksMap.size,
      }, { headers: corsHeaders(env) });

    } catch (browserError) {
      if (browser) await browser.close();
      throw browserError;
    }

  } catch (error) {
    console.error('Compose page error:', error);
    return Response.json(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500, headers: corsHeaders(env) }
    );
  }
}

/**
 * Request type for page finalize
 */
interface PageFinalizeRequest {
  branch: string;
  github: { owner: string; repo: string; token?: string };
}

/**
 * Handles /page-finalize endpoint
 * Merges page import branch to main
 */
async function handlePageFinalize(request: Request, env: Env): Promise<Response> {
  try {
    const body = await request.json() as PageFinalizeRequest;

    // Validate required fields
    if (!body.branch || !body.github?.owner || !body.github?.repo) {
      return Response.json(
        { success: false, error: 'Missing required fields: branch, github.owner, github.repo' },
        { status: 400, headers: corsHeaders(env) }
      );
    }

    const githubToken = body.github?.token || env.GITHUB_TOKEN;
    if (!githubToken) {
      return Response.json(
        { success: false, error: 'GitHub token not provided and GITHUB_TOKEN env not configured' },
        { status: 401, headers: corsHeaders(env) }
      );
    }

    console.log(`Finalizing page import: merging ${body.branch} into main`);

    const githubFetch = createGitHubFetcher(githubToken);

    // Create merge into main using GitHub merge API
    const mergeResponse = await githubFetch(
      `https://api.github.com/repos/${body.github.owner}/${body.github.repo}/merges`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          base: 'main',
          head: body.branch,
          commit_message: `Merge page import ${body.branch}`,
        }),
      }
    );

    if (!mergeResponse.ok) {
      // Check for specific errors
      if (mergeResponse.status === 409) {
        // Merge conflict
        const error = await mergeResponse.json() as { message: string };
        return Response.json(
          { success: false, error: `Merge conflict: ${error.message}` },
          { status: 409, headers: corsHeaders(env) }
        );
      }
      const error = await mergeResponse.text();
      throw new Error(`Merge failed: ${mergeResponse.status} - ${error}`);
    }

    const mergeResult = await mergeResponse.json() as { sha: string; html_url?: string };
    console.log(`Page branch merged successfully: ${mergeResult.sha}`);

    // Optionally delete the branch after merge
    try {
      await githubFetch(
        `https://api.github.com/repos/${body.github.owner}/${body.github.repo}/git/refs/heads/${body.branch}`,
        { method: 'DELETE' }
      );
      console.log(`Deleted branch ${body.branch}`);
    } catch (deleteError) {
      console.warn(`Failed to delete branch ${body.branch}:`, deleteError);
      // Non-fatal, continue
    }

    return Response.json({
      success: true,
      commitSha: mergeResult.sha,
      commitUrl: mergeResult.html_url,
    }, { headers: corsHeaders(env) });

  } catch (error) {
    console.error('Page finalize error:', error);
    return Response.json(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500, headers: corsHeaders(env) }
    );
  }
}

/**
 * Request type for generate-block-for-section
 */
interface GenerateBlockForSectionRequest {
  url: string;
  sectionName: string;
  sectionDescription: string;
  sectionType?: string;
  sectionHtml?: string; // Optional HTML for better context
  yStart: number;
  yEnd: number;
  sessionId: string;
  github: { owner: string; repo: string; token?: string };
  da: { org: string; site: string };
}

/**
 * Handles /generate-block-for-section endpoint
 * Generates a single block using the standalone workflow (with preview branch)
 */
async function handleGenerateBlockForSection(request: Request, env: Env): Promise<Response> {
  try {
    const body = await request.json() as GenerateBlockForSectionRequest;

    // Validate required fields
    if (!body.url || !body.sectionName || !body.sectionDescription || !body.sessionId ||
        !body.github?.owner || !body.github?.repo || !body.da?.org || !body.da?.site) {
      return Response.json(
        { success: false, error: 'Missing required fields' },
        { status: 400, headers: corsHeaders(env) }
      );
    }

    const githubToken = body.github?.token || env.GITHUB_TOKEN;
    if (!githubToken) {
      return Response.json(
        { success: false, error: 'GitHub token not provided' },
        { status: 401, headers: corsHeaders(env) }
      );
    }

    console.log(`Generating block for section: ${body.sectionName} (Y: ${body.yStart}-${body.yEnd})`);

    // Generate block using Claude Vision (same as standalone block workflow)
    const block = await generateBlockFromDescription(
      body.url,
      body.sectionDescription,
      body.sectionName,
      env,
      body.yStart,
      body.yEnd
    );

    if (!block) {
      return Response.json(
        { success: false, error: 'Block generation failed' },
        { status: 500, headers: corsHeaders(env) }
      );
    }

    const blockName = block.blockName || body.sectionType || body.sectionName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
    console.log(`Block generated: ${blockName}`);

    // Create a preview branch for this block (using session ID)
    const variantBranch = `${body.sessionId}-1-1`; // Single iteration for page import
    const githubFetch = createGitHubFetcher(githubToken);

    console.log(`Creating preview branch: ${variantBranch}`);
    await ensureBranchExists(githubFetch, body.github.owner, body.github.repo, variantBranch, 'main');

    // Push block code to branch
    const { commitSha, commitUrl } = await pushFilesToBranch(
      githubFetch,
      body.github.owner,
      body.github.repo,
      variantBranch,
      [
        { path: `blocks/${blockName}/${blockName}.js`, content: block.js },
        { path: `blocks/${blockName}/${blockName}.css`, content: block.css },
      ],
      `Add ${blockName} block for section "${body.sectionName}"`
    );

    console.log(`Block code pushed to GitHub: ${commitUrl}`);

    // Push HTML to DA for preview
    const daBasePath = '/drafts/gen';
    const variantDaPath = `${daBasePath}/${body.sessionId}-1-1`;
    const wrappedHtml = wrapBlockInPageStructure(block.html);

    // Get DA token
    let daToken: string | null = null;
    if (env.DA_CLIENT_ID && env.DA_CLIENT_SECRET && env.DA_SERVICE_TOKEN) {
      daToken = await exchangeDACredentialsForToken(
        env.DA_CLIENT_ID,
        env.DA_CLIENT_SECRET,
        env.DA_SERVICE_TOKEN
      );
    }

    if (daToken) {
      const daUrl = `https://admin.da.live/source/${body.da.org}/${body.da.site}${variantDaPath}.html`;
      const formData = new FormData();
      formData.append('data', new Blob([wrappedHtml], { type: 'text/html' }));

      const daResponse = await fetch(daUrl, {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${daToken}` },
        body: formData,
      });

      if (daResponse.ok) {
        console.log(`Block HTML pushed to DA: ${variantDaPath}`);

        // Trigger AEM preview
        const aemPreviewUrl = `https://admin.hlx.page/preview/${body.github.owner}/${body.github.repo}/${variantBranch}${variantDaPath}`;
        try {
          await fetch(aemPreviewUrl, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${daToken}` },
          });
          console.log('AEM preview triggered');
        } catch (e) {
          console.warn('AEM preview trigger failed (non-fatal):', e);
        }
      } else {
        console.warn('DA push failed:', await daResponse.text());
      }
    }

    // Build preview URL
    const previewUrl = `https://${variantBranch}--${body.da.site}--${body.da.org}.aem.page${variantDaPath}`;

    return Response.json({
      success: true,
      blockName,
      previewUrl,
      branch: variantBranch,
      html: block.html,
      css: block.css,
      js: block.js,
    }, { headers: corsHeaders(env) });

  } catch (error) {
    console.error('Generate block for section error:', error);
    return Response.json(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500, headers: corsHeaders(env) }
    );
  }
}

/**
 * Handles the preview request - returns a full HTML page
 * Supports both bounding box (new) and selector (legacy) approaches
 */
async function handlePreview(request: Request, env: Env): Promise<Response> {
  try {
    const body = await parseRequestBody(request);

    let blockName: string;
    let blockHTML: string;
    let blockJS: string;
    let blockCSS: string;
    let componentType: string | undefined;

    // NEW: Description-based approach (from /analyze) with Y-boundaries
    if (body.sectionDescription && body.sectionName) {
      console.log(`Preview: Using description-based approach for "${body.sectionName}" (Y: ${body.yStart}-${body.yEnd})`);
      const enhancedBlock = await generateBlockFromDescription(
        body.url,
        body.sectionDescription,
        body.sectionName,
        env,
        body.yStart || 0,
        body.yEnd || 0
      );

      if (!enhancedBlock) {
        return Response.json(
          { success: false, error: 'Block generation failed', code: 'GENERATION_FAILED' },
          { status: 500, headers: corsHeaders(env) }
        );
      }

      blockName = enhancedBlock.blockName;
      blockHTML = enhancedBlock.html;
      blockJS = enhancedBlock.js;
      blockCSS = enhancedBlock.css;
      componentType = enhancedBlock.componentType;
    }
    // Bounding box approach
    else if (body.boundingBox) {
      console.log('Preview: Using bounding box approach');
      const enhancedBlock = await generateBlockFromBoundingBox(body.url, body.boundingBox, env);

      if (!enhancedBlock) {
        return Response.json(
          { success: false, error: 'Block generation failed', code: 'GENERATION_FAILED' },
          { status: 500, headers: corsHeaders(env) }
        );
      }

      blockName = enhancedBlock.blockName;
      blockHTML = enhancedBlock.html;
      blockJS = enhancedBlock.js;
      blockCSS = enhancedBlock.css;
      componentType = enhancedBlock.componentType;
    }
    // LEGACY: Selector approach
    else if (body.selector) {
      console.log('Preview: Using selector approach (legacy)');
      const html = await fetchPage(body.url);
      const document = parseHTMLDocument(html);
      const element = getElement(document, body.selector);

      let combinedHtml = element.outerHTML;
      if (body.siblingSelectors && body.siblingSelectors.length > 0) {
        const siblingHtmlParts: string[] = [];
        for (const sibSel of body.siblingSelectors) {
          try {
            const sibEl = getElement(document, sibSel);
            siblingHtmlParts.push(sibEl.innerHTML);
          } catch (e) {
            console.log(`Could not get sibling element: ${sibSel}`);
          }
        }
        if (siblingHtmlParts.length > 0) {
          combinedHtml = `<div class="merged-content">${element.innerHTML}${siblingHtmlParts.join('')}</div>`;
        }
      }

      const extracted = extractContent(combinedHtml, body.url);
      const enhancedBlock = await generateBlockFromScreenshotEnhanced(body.url, body.selector, combinedHtml, env);

      if (enhancedBlock) {
        blockName = enhancedBlock.blockName;
        blockHTML = enhancedBlock.html;
        blockJS = enhancedBlock.js;
        blockCSS = enhancedBlock.css;
        componentType = enhancedBlock.componentType;
      } else {
        const legacyBlock = await generateBlockFromScreenshot(body.url, body.selector, extracted, env);
        if (legacyBlock) {
          blockName = legacyBlock.blockName;
          blockHTML = legacyBlock.html;
          blockJS = legacyBlock.js;
          blockCSS = legacyBlock.css;
        } else {
          const block = buildBlock(extracted);
          blockName = block.blockName;
          blockHTML = block.html;
          blockJS = block.js;
          blockCSS = block.css;
        }
      }
    } else {
      return Response.json(
        { success: false, error: 'sectionDescription+sectionName, boundingBox, or selector is required', code: 'INVALID_REQUEST' },
        { status: 400, headers: corsHeaders(env) }
      );
    }

    const previewHTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Block Preview: ${blockName}</title>
  <style>
    /* Reset and base styles */
    *, *::before, *::after {
      box-sizing: border-box;
    }

    :root {
      --background-color: #fff;
      --light-color: #f8f8f8;
      --dark-color: #505050;
      --text-color: #131313;
      --link-color: #3b63fb;
      --link-hover-color: #1d3ecf;
      --heading-font-size-xxl: 48px;
      --heading-font-size-xl: 40px;
      --heading-font-size-l: 32px;
      --heading-font-size-m: 24px;
      --heading-font-size-s: 20px;
      --body-font-size-m: 18px;
      --body-font-size-s: 16px;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      margin: 0;
      padding: 20px;
      background: #f5f5f5;
      color: var(--text-color);
      line-height: 1.5;
    }

    .preview-header {
      background: #fff;
      padding: 20px;
      margin: -20px -20px 20px;
      border-bottom: 1px solid #ddd;
    }

    .preview-header h1 {
      margin: 0 0 8px;
      font-size: 24px;
    }

    .preview-header .meta {
      color: #666;
      font-size: 14px;
    }

    .preview-header code {
      background: #f0f0f0;
      padding: 2px 6px;
      border-radius: 4px;
      font-size: 13px;
    }

    .preview-container {
      background: #fff;
      border-radius: 8px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.1);
      overflow: hidden;
    }

    .preview-content {
      padding: 0 20px;
    }

    /* Generated block CSS */
    ${blockCSS}
  </style>
</head>
<body>
  <div class="preview-header">
    <h1>Block Preview</h1>
    <p class="meta">
      Block: <code>${blockName}</code> |
      Pattern: <code>${componentType || 'unknown'}</code> |
      Source: <code>${body.url}</code>
    </p>
  </div>

  <div class="preview-container">
    <div class="preview-content">
      ${blockHTML}
    </div>
  </div>

  <script type="module">
    // Simulated aem.js utilities
    function createOptimizedPicture(src, alt = '', eager = false, breakpoints = [{ width: '750' }]) {
      const picture = document.createElement('picture');
      breakpoints.forEach((bp, i) => {
        const source = document.createElement('source');
        source.type = 'image/webp';
        source.srcset = src;
        if (bp.media) source.media = bp.media;
        picture.appendChild(source);
      });
      const img = document.createElement('img');
      img.src = src;
      img.alt = alt;
      img.loading = eager ? 'eager' : 'lazy';
      picture.appendChild(img);
      return picture;
    }

    // Make it available globally for the block script
    window.createOptimizedPicture = createOptimizedPicture;

    // Block decoration function
    ${blockJS.replace(/import\s*{[^}]*}\s*from\s*['"][^'"]*['"];?\s*/g, '')}

    // Run decoration
    const blockEl = document.querySelector('.${blockName}');
    if (blockEl && typeof decorate === 'function') {
      decorate(blockEl);
    }
  </script>
</body>
</html>`;

    return new Response(previewHTML, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Access-Control-Allow-Origin': env.ALLOWED_ORIGINS || '*',
      },
    });
  } catch (error) {
    // Return JSON errors so API clients can parse them
    if (error instanceof BlockGeneratorError) {
      return Response.json(
        { success: false, error: error.message, code: error.code },
        { status: error.statusCode, headers: corsHeaders(env) }
      );
    }
    return Response.json(
      { success: false, error: 'An unexpected error occurred', code: 'INTERNAL_ERROR' },
      { status: 500, headers: corsHeaders(env) }
    );
  }
}

/**
 * Core block generation logic - reusable with an existing browser instance
 * This is the extracted core from handleBlockGenerate for use in batch operations
 */
interface GenerateBlockCoreParams {
  browser: ReturnType<typeof puppeteer.launch> extends Promise<infer T> ? T : never;
  url: string;
  screenshotBase64: string;
  html: string;
  xpath: string;
  anthropicConfig: AnthropicConfig;
}

interface GenerateBlockCoreResult {
  block: BlockCode;
  screenshotBase64: string;
  screenshotMediaType: 'image/png' | 'image/jpeg';
  liveImages: ExtractedImage[];
}

async function generateBlockCore(params: GenerateBlockCoreParams): Promise<GenerateBlockCoreResult> {
  const { browser, url, xpath, anthropicConfig } = params;
  let { screenshotBase64, html } = params;

  let extractedCssStyles: string | undefined;
  let liveImages: ExtractedImage[] = [];
  let screenshotMediaType: 'image/png' | 'image/jpeg' = 'image/png';

  // Compress screenshot if too large for Claude API (5MB limit)
  const compressed = await compressImageIfNeeded(browser, screenshotBase64);
  screenshotBase64 = compressed.data;
  screenshotMediaType = compressed.mediaType;

  // Try to navigate and extract additional data (CSS, images, HTML via XPath)
  // This is optional - if navigation fails but we have html, we can continue
  let pageNavigationSucceeded = false;
  let page: Awaited<ReturnType<typeof browser.newPage>> | null = null;

  try {
    page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });
    pageNavigationSucceeded = true;

    // Dismiss cookie banners
    await dismissCookieBanners(page);

    // If xpath is provided, extract HTML from that element
    if (xpath && !html) {
      try {
        console.log(`Extracting HTML from XPath: ${xpath}`);
        const extractedHtml = await page.evaluate((xpathExpr: string) => {
          const result = document.evaluate(
            xpathExpr,
            document,
            null,
            XPathResult.FIRST_ORDERED_NODE_TYPE,
            null
          );
          const element = result.singleNodeValue as Element;
          if (element) {
            return element.outerHTML;
          }
          return null;
        }, xpath);

        if (extractedHtml) {
          html = extractedHtml;
          console.log(`Extracted HTML from XPath (${html.length} chars)`);
        } else {
          console.warn(`No element found at XPath: ${xpath}`);
        }
      } catch (xpathError) {
        console.warn('XPath extraction failed:', xpathError);
      }
    }

    // Extract live images
    try {
      console.log('Extracting live images from page...');
      liveImages = await extractLiveImages(page, 'body', url);
      console.log(`Found ${liveImages.length} live images`);
    } catch (imgError) {
      console.warn('Live image extraction failed:', imgError);
    }

    // Extract computed styles from the page
    try {
      console.log('Extracting computed CSS styles...');
      const styles = await extractComputedStyles(browser, url, 'body');
      extractedCssStyles = formatStylesForPrompt(styles);
    } catch (styleError) {
      console.warn('Style extraction failed:', styleError);
    }
  } catch (navigationError) {
    console.warn('Page navigation failed, continuing without extraction:', navigationError);
    // If we already have html, we can continue without the extracted data
  } finally {
    if (page) {
      try {
        await page.close();
      } catch (e) {
        // Ignore close errors
      }
    }
  }

  // Validate we have html
  if (!html) {
    throw new BlockGeneratorError('Could not extract HTML from provided xpath', 'PARSE_ERROR', 400);
  }

  // Generate block using the enhanced generator
  console.log(`Generating block with Claude Vision... (mediaType=${screenshotMediaType})`);
  const enhancedBlock = await generateBlockEnhanced(
    screenshotBase64,
    html,
    url,
    anthropicConfig,
    extractedCssStyles,
    liveImages,
    screenshotMediaType
  );

  return {
    block: {
      html: enhancedBlock.html,
      css: enhancedBlock.css,
      js: enhancedBlock.js,
      blockName: enhancedBlock.blockName,
    },
    screenshotBase64,
    screenshotMediaType,
    liveImages,
  };
}

/**
 * Handles the block-generate endpoint
 * Accepts multipart form data with screenshot, URL, and HTML
 */
async function handleBlockGenerate(request: Request, env: Env): Promise<Response> {
  try {
    const formData = await request.formData();

    const url = formData.get('url') as string;
    const screenshotFile = formData.get('screenshot') as File;
    const html = formData.get('html') as string;
    const xpath = formData.get('xpath') as string;

    // Validate required fields with specific messages
    const missing: string[] = [];
    if (!url) missing.push('url');
    if (!screenshotFile) missing.push('screenshot');
    if (!html && !xpath) missing.push('html or xpath');

    if (missing.length > 0) {
      return Response.json(
        { success: false, error: `Missing required fields: ${missing.join(', ')}`, code: 'INVALID_REQUEST' },
        { status: 400, headers: corsHeaders(env) }
      );
    }

    // Get Anthropic config
    const anthropicConfig = getAnthropicConfig(env);
    if (!anthropicConfig) {
      return Response.json(
        { success: false, error: 'Anthropic API not configured', code: 'INTERNAL_ERROR' },
        { status: 500, headers: corsHeaders(env) }
      );
    }

    if (!env.BROWSER) {
      return Response.json(
        { success: false, error: 'Browser Rendering not configured', code: 'INTERNAL_ERROR' },
        { status: 500, headers: corsHeaders(env) }
      );
    }

    // Convert screenshot File to base64 (chunk-based to avoid stack overflow)
    const arrayBuffer = await screenshotFile.arrayBuffer();
    const screenshotBase64 = arrayBufferToBase64(arrayBuffer);

    let result: GenerateBlockCoreResult;
    try {
      const browser = await launchBrowserWithRetry(env.BROWSER);
      try {
        result = await generateBlockCore({
          browser,
          url,
          screenshotBase64,
          html,
          xpath,
          anthropicConfig,
        });
      } finally {
        await browser.close();
      }
    } catch (browserError) {
      if (browserError instanceof BlockGeneratorError) {
        throw browserError;
      }
      const errorMessage = browserError instanceof Error ? browserError.message : String(browserError);
      console.error('Browser operations failed:', errorMessage, browserError);
      return Response.json(
        { success: false, error: `Browser operations failed: ${errorMessage}`, code: 'BROWSER_ERROR' },
        { status: 500, headers: corsHeaders(env) }
      );
    }

    // Build response
    const response: BlockResponse = {
      success: true,
      blockName: result.block.blockName || 'block',
      layoutPattern: 'unknown',
      html: result.block.html,
      js: result.block.js,
      css: result.block.css,
      metadata: {
        elementCount: 0,
        hasImages: result.liveImages.length > 0,
        hasHeadings: true,
        hasLinks: true,
        rowCount: 1,
        columnCount: 1,
      },
    };

    return Response.json(response, { status: 200, headers: corsHeaders(env) });
  } catch (error) {
    return handleError(error, env);
  }
}

/**
 * Handles the block-generate-full endpoint
 * Generates initial block + 2 refinements in a single browser session
 * This reduces browser session usage from 3 sessions to 1 per option
 */
async function handleBlockGenerateFull(request: Request, env: Env): Promise<Response> {
  try {
    const formData = await request.formData();

    const url = formData.get('url') as string;
    const screenshotFile = formData.get('screenshot') as File;
    const html = formData.get('html') as string;
    const xpath = formData.get('xpath') as string;
    const refinementCount = parseInt(formData.get('refinements') as string || '2', 10);

    // Validate required fields
    const missing: string[] = [];
    if (!url) missing.push('url');
    if (!screenshotFile) missing.push('screenshot');
    if (!html && !xpath) missing.push('html or xpath');

    if (missing.length > 0) {
      return Response.json(
        { success: false, error: `Missing required fields: ${missing.join(', ')}`, code: 'INVALID_REQUEST' },
        { status: 400, headers: corsHeaders(env) }
      );
    }

    // Get Anthropic config
    const anthropicConfig = getAnthropicConfig(env);
    if (!anthropicConfig) {
      return Response.json(
        { success: false, error: 'Anthropic API not configured', code: 'INTERNAL_ERROR' },
        { status: 500, headers: corsHeaders(env) }
      );
    }

    if (!env.BROWSER) {
      return Response.json(
        { success: false, error: 'Browser Rendering not configured', code: 'INTERNAL_ERROR' },
        { status: 500, headers: corsHeaders(env) }
      );
    }

    // Convert screenshot File to base64
    const arrayBuffer = await screenshotFile.arrayBuffer();
    const screenshotBase64 = arrayBufferToBase64(arrayBuffer);

    const iterations: BlockCode[] = [];

    try {
      const browser = await launchBrowserWithRetry(env.BROWSER);
      try {
        // Step 1: Generate initial block
        console.log('[block-generate-full] Generating initial block...');
        const initialResult = await generateBlockCore({
          browser,
          url,
          screenshotBase64,
          html,
          xpath,
          anthropicConfig,
        });
        iterations.push(initialResult.block);

        // Step 2: Refinement iterations (reusing the same browser session)
        let currentBlock = initialResult.block;
        for (let i = 0; i < refinementCount; i++) {
          console.log(`[block-generate-full] Refinement ${i + 1}/${refinementCount}...`);
          const refinedResult = await refineBlock(
            browser,
            initialResult.screenshotBase64,
            currentBlock,
            anthropicConfig,
            { width: 1440, height: 900 }
          );
          currentBlock = refinedResult.block;
          iterations.push(refinedResult.block);
        }
      } finally {
        await browser.close();
      }
    } catch (browserError) {
      if (browserError instanceof BlockGeneratorError) {
        throw browserError;
      }
      const errorMessage = browserError instanceof Error ? browserError.message : String(browserError);
      console.error('Browser operations failed:', errorMessage, browserError);
      return Response.json(
        { success: false, error: `Browser operations failed: ${errorMessage}`, code: 'BROWSER_ERROR' },
        { status: 500, headers: corsHeaders(env) }
      );
    }

    // Return all iterations
    return Response.json({
      success: true,
      iterations: iterations.map((block, index) => ({
        iteration: index,
        blockName: block.blockName,
        html: block.html,
        css: block.css,
        js: block.js,
      })),
    }, { status: 200, headers: corsHeaders(env) });
  } catch (error) {
    return handleError(error, env);
  }
}

/**
 * Handles the block-refine endpoint
 * Accepts existing block code and refines it using pixelmatch comparison
 */
async function handleBlockRefine(request: Request, env: Env): Promise<Response> {
  try {
    const formData = await request.formData();

    const url = formData.get('url') as string;
    const screenshotFile = formData.get('screenshot') as File;
    let html = formData.get('html') as string;
    const xpath = formData.get('xpath') as string;
    const blockHtml = formData.get('blockHtml') as string;
    const blockCss = formData.get('blockCss') as string;
    const blockJs = formData.get('blockJs') as string;
    const blockName = formData.get('blockName') as string || 'refined-block';
    const refinePrompt = formData.get('prompt') as string;

    // Validate required fields - html OR xpath must be provided
    const missing: string[] = [];
    if (!url) missing.push('url');
    if (!screenshotFile) missing.push('screenshot');
    if (!html && !xpath) missing.push('html or xpath');
    if (!blockHtml) missing.push('blockHtml');
    if (!blockCss) missing.push('blockCss');
    if (!blockJs) missing.push('blockJs');

    if (missing.length > 0) {
      return Response.json(
        { success: false, error: `Missing required fields: ${missing.join(', ')}`, code: 'INVALID_REQUEST' },
        { status: 400, headers: corsHeaders(env) }
      );
    }

    // Get Anthropic config
    const anthropicConfig = getAnthropicConfig(env);
    if (!anthropicConfig) {
      return Response.json(
        { success: false, error: 'Anthropic API not configured', code: 'INTERNAL_ERROR' },
        { status: 500, headers: corsHeaders(env) }
      );
    }

    if (!env.BROWSER) {
      return Response.json(
        { success: false, error: 'Browser Rendering not configured', code: 'INTERNAL_ERROR' },
        { status: 500, headers: corsHeaders(env) }
      );
    }

    // Convert screenshot File to base64
    const arrayBuffer = await screenshotFile.arrayBuffer();
    let originalScreenshotBase64 = arrayBufferToBase64(arrayBuffer);

    // Create current block object
    const currentBlock: BlockCode = {
      html: blockHtml,
      css: blockCss,
      js: blockJs,
      blockName
    };

    // Launch Puppeteer with retry logic and refine
    const browser = await launchBrowserWithRetry(env.BROWSER);

    // For refine endpoint, keep original PNG for pixelmatch comparison
    // Compression for Claude API will be handled inside refineBlock's analyzeAndRefine
    // Note: We don't compress here because compareScreenshots needs PNG format

    // If xpath is provided but html is not, extract the HTML
    if (xpath && !html) {
      try {
        const page = await browser.newPage();
        await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });
        console.log(`Extracting HTML from XPath: ${xpath}`);
        const extractedHtml = await page.evaluate((xpathExpr: string) => {
          const result = document.evaluate(
            xpathExpr,
            document,
            null,
            XPathResult.FIRST_ORDERED_NODE_TYPE,
            null
          );
          const element = result.singleNodeValue as Element;
          return element ? element.outerHTML : null;
        }, xpath);
        if (extractedHtml) {
          html = extractedHtml;
          console.log(`Extracted HTML from XPath (${html.length} chars)`);
        }
        await page.close();
      } catch (xpathError) {
        console.warn('XPath extraction failed:', xpathError);
      }
    }
    try {
      const result = await refineBlock(
        browser,
        originalScreenshotBase64,
        currentBlock,
        anthropicConfig,
        { width: 1440, height: 900 },
        refinePrompt || undefined
      );

      // Build response
      const response = {
        success: true,
        blockName: result.block.blockName || blockName,
        html: result.block.html,
        js: result.block.js,
        css: result.block.css,
        refinementApplied: result.refinementApplied,
        refinementNotes: result.refinementNotes,
        generatedScreenshot: result.generatedScreenshot
      };

      return Response.json(response, { status: 200, headers: corsHeaders(env) });
    } finally {
      await browser.close();
    }
  } catch (error) {
    return handleError(error, env);
  }
}

/**
 * Handle block-winner endpoint: select the best block from multiple options using Claude Vision
 * Receives original screenshot + array of blocks (latest iteration per option)
 * If blocks have previewUrl, captures screenshots from EDS preview instead of local rendering
 * Returns the winning block with reasoning
 */
async function handleBlockWinner(request: Request, env: Env): Promise<Response> {
  try {
    const formData = await request.formData();

    const screenshotFile = formData.get('screenshot') as File;
    const blocksJson = formData.get('blocks') as string;

    if (!screenshotFile || !blocksJson) {
      return Response.json(
        { success: false, error: 'Missing required fields: screenshot and blocks', code: 'INVALID_REQUEST' },
        { status: 400, headers: corsHeaders(env) }
      );
    }

    // Parse blocks array - now includes optional previewUrl
    let blocks: Array<{ html: string; css: string; js: string; blockName?: string; optionIndex: number; previewUrl?: string }>;
    try {
      blocks = JSON.parse(blocksJson);
    } catch {
      return Response.json(
        { success: false, error: 'Invalid blocks JSON', code: 'INVALID_REQUEST' },
        { status: 400, headers: corsHeaders(env) }
      );
    }

    if (!Array.isArray(blocks) || blocks.length === 0) {
      return Response.json(
        { success: false, error: 'Blocks must be a non-empty array', code: 'INVALID_REQUEST' },
        { status: 400, headers: corsHeaders(env) }
      );
    }

    // Get Anthropic config
    const anthropicConfig = getAnthropicConfig(env);
    if (!anthropicConfig) {
      return Response.json(
        { success: false, error: 'Anthropic API not configured', code: 'INTERNAL_ERROR' },
        { status: 500, headers: corsHeaders(env) }
      );
    }

    if (!env.BROWSER) {
      return Response.json(
        { success: false, error: 'Browser Rendering not configured', code: 'INTERNAL_ERROR' },
        { status: 500, headers: corsHeaders(env) }
      );
    }

    // Convert screenshot to base64
    const arrayBuffer = await screenshotFile.arrayBuffer();
    const originalScreenshotBase64 = arrayBufferToBase64(arrayBuffer);

    // Launch browser
    const browser = await launchBrowserWithRetry(env.BROWSER);

    try {
      // Capture screenshots - either from EDS preview URLs or local rendering
      console.log(`Capturing ${blocks.length} blocks for comparison...`);
      const renderedScreenshots: string[] = [];

      for (let i = 0; i < blocks.length; i++) {
        const block = blocks[i];

        // If EDS preview URL is available, capture from that
        if (block.previewUrl) {
          console.log(`  Capturing EDS preview ${i + 1}/${blocks.length}: ${block.previewUrl}`);
          try {
            const screenshot = await captureUrlScreenshot(browser, block.previewUrl, { width: 1440, height: 900 });
            renderedScreenshots.push(screenshot);
          } catch (edsErr) {
            console.warn(`  EDS capture failed, falling back to local render:`, edsErr);
            // Fallback to local rendering if EDS preview fails
            const screenshot = await renderBlockToScreenshot(
              browser,
              { html: block.html, css: block.css, js: block.js, blockName: block.blockName },
              { width: 1440, height: 900 }
            );
            renderedScreenshots.push(screenshot);
          }
        } else {
          // No EDS URL, render locally
          console.log(`  Rendering block ${i + 1}/${blocks.length} locally...`);
          const screenshot = await renderBlockToScreenshot(
            browser,
            { html: block.html, css: block.css, js: block.js, blockName: block.blockName },
            { width: 1440, height: 900 }
          );
          renderedScreenshots.push(screenshot);
        }
      }

      // Compress images if needed for Claude API
      const compressedOriginal = await compressImageIfNeeded(browser, originalScreenshotBase64);

      const compressedRendered: Array<{ data: string; mediaType: 'image/png' | 'image/jpeg' }> = [];
      for (const screenshot of renderedScreenshots) {
        const compressed = await compressImageIfNeeded(browser, screenshot);
        compressedRendered.push(compressed);
      }

      // Build the vision prompt
      const content: Array<{ type: string; source?: any; text?: string }> = [];

      // Add original image
      content.push({
        type: 'text',
        text: 'Image 1: ORIGINAL DESIGN (target) - this is what we want to match'
      });
      content.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: compressedOriginal.mediaType,
          data: compressedOriginal.data
        }
      });

      // Add rendered blocks
      for (let i = 0; i < compressedRendered.length; i++) {
        content.push({
          type: 'text',
          text: `Image ${i + 2}: OPTION ${blocks[i].optionIndex + 1} - Generated block`
        });
        content.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: compressedRendered[i].mediaType,
            data: compressedRendered[i].data
          }
        });
      }

      // Add the prompt
      content.push({
        type: 'text',
        text: `You are an expert at visual comparison. I'm showing you an ORIGINAL design and ${blocks.length} generated OPTIONS.

Compare each option to the original design and determine which one is the BEST MATCH.

Evaluate based on:
1. Layout accuracy (positioning, alignment, spacing)
2. Visual fidelity (colors, typography, contrast)
3. Content completeness (are all elements present?)
4. Proportions and sizing
5. Overall visual impression

Return ONLY a JSON object:
{
  "winner": <option number 1-${blocks.length}>,
  "confidence": <0-100>,
  "reasoning": "<brief explanation of why this option is best>",
  "scores": [
    { "option": 1, "score": <0-100>, "notes": "<brief notes>" },
    { "option": 2, "score": <0-100>, "notes": "<brief notes>" },
    ...
  ]
}`
      });

      // Call Claude API
      let response: Response;

      if (anthropicConfig.useBedrock && anthropicConfig.bedrockToken) {
        const region = anthropicConfig.bedrockRegion || 'us-east-1';
        const model = anthropicConfig.bedrockModel || 'anthropic.claude-sonnet-4-20250514-v1:0';
        const bedrockUrl = `https://bedrock-runtime.${region}.amazonaws.com/model/${encodeURIComponent(model)}/invoke`;

        response = await fetch(bedrockUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${anthropicConfig.bedrockToken}`,
          },
          body: JSON.stringify({
            anthropic_version: 'bedrock-2023-05-31',
            max_tokens: 4096,
            messages: [{ role: 'user', content }],
          }),
        });
      } else if (anthropicConfig.apiKey) {
        response = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': anthropicConfig.apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 4096,
            messages: [{ role: 'user', content }],
          }),
        });
      } else {
        return Response.json(
          { success: false, error: 'No Anthropic API configuration', code: 'INTERNAL_ERROR' },
          { status: 500, headers: corsHeaders(env) }
        );
      }

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Claude API error: ${response.status} - ${error}`);
      }

      const result = await response.json() as {
        content: Array<{ type: string; text?: string }>;
      };

      const textContent = result.content.find(c => c.type === 'text');
      if (!textContent?.text) {
        throw new Error('No text response from Claude');
      }

      // Parse the JSON response
      const jsonMatch = textContent.text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('Failed to parse winner selection from Claude');
      }

      const winnerResult = JSON.parse(jsonMatch[0]) as {
        winner: number;
        confidence: number;
        reasoning: string;
        scores: Array<{ option: number; score: number; notes: string }>;
      };

      // Get the winning block
      const winnerIndex = winnerResult.winner - 1;
      const winningBlock = blocks[winnerIndex];

      return Response.json({
        success: true,
        winner: {
          optionIndex: winningBlock.optionIndex,
          blockName: winningBlock.blockName,
          html: winningBlock.html,
          css: winningBlock.css,
          js: winningBlock.js
        },
        confidence: winnerResult.confidence,
        reasoning: winnerResult.reasoning,
        scores: winnerResult.scores,
        screenshots: renderedScreenshots.map((s, i) => ({
          optionIndex: blocks[i].optionIndex,
          screenshot: s
        }))
      }, { status: 200, headers: corsHeaders(env) });

    } finally {
      await browser.close();
    }
  } catch (error) {
    return handleError(error, env);
  }
}

/**
 * Returns the test UI HTML page for block-generate and block-refine
 */
function handleBlockTestUI(env: Env): Response {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Block Generator Test UI</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #f5f5f5;
      min-height: 100vh;
      padding: 20px;
    }
    .container {
      max-width: 1800px;
      margin: 0 auto;
    }
    h1 {
      margin-bottom: 20px;
      color: #333;
    }
    .panels {
      display: grid;
      grid-template-columns: 400px 1fr;
      gap: 20px;
    }
    .panel {
      background: white;
      border-radius: 8px;
      padding: 20px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
    }
    .panel.wide {
      min-width: 0;
    }
    .panel h2 {
      margin-bottom: 15px;
      color: #444;
      font-size: 18px;
    }
    .form-group {
      margin-bottom: 15px;
    }
    label {
      display: block;
      margin-bottom: 5px;
      font-weight: 500;
      color: #555;
    }
    input[type="text"], input[type="url"], textarea {
      width: 100%;
      padding: 10px;
      border: 1px solid #ddd;
      border-radius: 4px;
      font-size: 14px;
    }
    textarea {
      min-height: 150px;
      font-family: 'Monaco', 'Menlo', monospace;
      font-size: 12px;
    }
    input[type="file"] {
      padding: 10px 0;
    }
    button {
      background: #0066cc;
      color: white;
      border: none;
      padding: 12px 24px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 14px;
      font-weight: 500;
    }
    button:hover {
      background: #0055aa;
    }
    button:disabled {
      background: #ccc;
      cursor: not-allowed;
    }
    button.refine {
      background: #00aa66;
    }
    button.refine:hover {
      background: #008855;
    }
    button.winner {
      background: #9933cc;
    }
    button.winner:hover {
      background: #7722aa;
    }
    button.save-github {
      background: #24292e;
    }
    button.save-github:hover {
      background: #1a1e22;
    }
    button.save-da {
      background: #eb1000;
    }
    button.save-da:hover {
      background: #c40d00;
    }
    button.design-system {
      background: #9c27b0;
    }
    button.design-system:hover {
      background: #7b1fa2;
    }
    .design-section {
      margin-bottom: 16px;
      padding: 12px;
      background: #f8f5ff;
      border-radius: 6px;
    }
    .design-section h4 {
      font-size: 12px;
      color: #9c27b0;
      margin-bottom: 8px;
      text-transform: uppercase;
    }
    .design-row {
      display: flex;
      justify-content: space-between;
      padding: 4px 0;
      font-size: 13px;
    }
    .design-label { color: #666; }
    .design-value { font-family: monospace; color: #333; }
    .color-swatches {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .swatch-item {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 3px 6px;
      background: white;
      border: 1px solid #ddd;
      border-radius: 4px;
      font-size: 11px;
    }
    .swatch {
      width: 16px;
      height: 16px;
      border-radius: 3px;
      border: 1px solid rgba(0,0,0,0.1);
    }
    .save-modal {
      display: none;
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0,0,0,0.5);
      z-index: 1000;
      align-items: center;
      justify-content: center;
    }
    .save-modal.active {
      display: flex;
    }
    .save-modal-content {
      background: white;
      border-radius: 12px;
      padding: 24px;
      max-width: 500px;
      width: 90%;
      max-height: 80vh;
      overflow-y: auto;
    }
    .save-modal h3 {
      margin: 0 0 20px 0;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .save-modal .form-group {
      margin-bottom: 15px;
    }
    .save-modal .form-group label {
      display: block;
      margin-bottom: 5px;
      font-weight: 500;
      color: #555;
    }
    .save-modal .form-group input {
      width: 100%;
      padding: 10px;
      border: 1px solid #ddd;
      border-radius: 4px;
    }
    .save-modal .row {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
    }
    .save-modal .button-row {
      display: flex;
      gap: 10px;
      margin-top: 20px;
    }
    .save-modal button {
      flex: 1;
    }
    .save-modal button.cancel {
      background: #6c757d;
    }
    .save-result {
      margin-top: 15px;
      padding: 12px;
      border-radius: 6px;
      font-size: 13px;
      display: none;
    }
    .save-result.success {
      display: block;
      background: #d4edda;
      border: 1px solid #28a745;
      color: #155724;
    }
    .save-result.error {
      display: block;
      background: #f8d7da;
      border: 1px solid #dc3545;
      color: #721c24;
    }
    .save-result a {
      color: inherit;
      font-weight: 500;
    }
    .winner-result {
      margin-top: 15px;
      padding: 15px;
      border-radius: 8px;
      background: linear-gradient(135deg, #f5f0ff 0%, #e8e0ff 100%);
      border: 2px solid #9933cc;
    }
    .winner-result h3 {
      margin: 0 0 10px 0;
      color: #6622aa;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .winner-result .reasoning {
      font-size: 14px;
      color: #333;
      margin-bottom: 10px;
    }
    .winner-result .scores {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
      gap: 10px;
      margin-top: 10px;
    }
    .winner-result .score-card {
      background: white;
      padding: 10px;
      border-radius: 6px;
      border: 1px solid #ddd;
    }
    .winner-result .score-card.winner {
      border-color: #9933cc;
      background: #f5f0ff;
    }
    .winner-result .score-card .option-name {
      font-weight: bold;
      margin-bottom: 5px;
    }
    .winner-result .score-card .score {
      font-size: 24px;
      font-weight: bold;
      color: #9933cc;
    }
    .winner-result .score-card .notes {
      font-size: 12px;
      color: #666;
      margin-top: 5px;
    }
    .button-group {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin-top: 15px;
    }
    .status {
      margin-top: 15px;
      padding: 10px;
      border-radius: 4px;
      font-size: 14px;
    }
    .status.loading {
      background: #fff3cd;
      color: #856404;
    }
    .status.success {
      background: #d4edda;
      color: #155724;
    }
    .status.error {
      background: #f8d7da;
      color: #721c24;
    }
    .preview-container {
      margin-top: 20px;
      border: 1px solid #ddd;
      border-radius: 4px;
      overflow: hidden;
    }
    .preview-header {
      background: #f8f9fa;
      padding: 10px 15px;
      border-bottom: 1px solid #ddd;
      font-weight: 500;
    }
    .preview-content {
      padding: 20px;
      background: #e0e0e0;
      overflow-x: auto;
    }
    .preview-frame-wrapper {
      background: white;
      margin: 0 auto;
      box-shadow: 0 2px 10px rgba(0,0,0,0.15);
      transition: width 0.3s ease;
    }
    .preview-content iframe {
      width: 100%;
      min-height: 600px;
      border: none;
      display: block;
    }
    .viewport-controls {
      display: flex;
      gap: 8px;
      padding: 10px 15px;
      background: #f0f0f0;
      border-bottom: 1px solid #ddd;
      align-items: center;
    }
    .viewport-controls label {
      margin: 0;
      font-size: 13px;
      color: #666;
    }
    .viewport-btn {
      padding: 6px 12px;
      font-size: 12px;
      background: #fff;
      border: 1px solid #ccc;
      border-radius: 4px;
      cursor: pointer;
      color: #333;
    }
    .viewport-btn:hover {
      background: #f5f5f5;
    }
    .viewport-btn.active {
      background: #0066cc;
      color: white;
      border-color: #0066cc;
    }
    .viewport-size {
      margin-left: auto;
      font-size: 12px;
      color: #666;
    }
    .images-row {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 15px;
      margin-top: 15px;
    }
    .image-box {
      text-align: center;
    }
    .image-box img {
      max-width: 100%;
      border: 1px solid #ddd;
      border-radius: 4px;
    }
    .image-box p {
      margin-top: 5px;
      font-size: 12px;
      color: #666;
    }
    .iteration-count {
      font-size: 14px;
      color: #666;
      margin-left: 10px;
    }
    pre {
      background: #f4f4f4;
      padding: 10px;
      border-radius: 4px;
      overflow-x: auto;
      font-size: 11px;
      max-height: 200px;
      overflow-y: auto;
    }
    .tabs {
      display: flex;
      border-bottom: 1px solid #ddd;
      margin-bottom: 15px;
    }
    .tab {
      padding: 10px 20px;
      cursor: pointer;
      border-bottom: 2px solid transparent;
      color: #666;
    }
    .tab.active {
      border-bottom-color: #0066cc;
      color: #0066cc;
    }
    .tab-content {
      display: none;
    }
    .tab-content.active {
      display: block;
    }
    .option-tabs {
      display: flex;
      gap: 10px;
      margin-bottom: 15px;
    }
    .option-tab {
      padding: 8px 16px;
      border: 2px solid #ddd;
      border-radius: 6px;
      cursor: pointer;
      background: #f8f9fa;
      font-weight: 500;
      color: #666;
      transition: all 0.2s;
    }
    .option-tab:hover {
      border-color: #0066cc;
      color: #0066cc;
    }
    .option-tab.active {
      border-color: #0066cc;
      background: #0066cc;
      color: white;
    }
    .option-tab.loading {
      border-color: #ffc107;
      background: #fff3cd;
      color: #856404;
    }
    .option-tab.error {
      border-color: #dc3545;
      background: #f8d7da;
      color: #721c24;
    }
    .option-tab.success {
      border-color: #28a745;
    }
    .iteration-tabs {
      display: flex;
      gap: 6px;
      margin-bottom: 15px;
      padding: 8px 12px;
      background: #f0f4f8;
      border-radius: 6px;
    }
    .iteration-tab {
      padding: 5px 12px;
      border: 1px solid #ccc;
      border-radius: 4px;
      cursor: pointer;
      background: white;
      font-size: 12px;
      color: #666;
      transition: all 0.2s;
    }
    .iteration-tab:hover {
      border-color: #0066cc;
      color: #0066cc;
    }
    .iteration-tab.active {
      border-color: #0066cc;
      background: #e6f0ff;
      color: #0066cc;
      font-weight: 500;
    }
    .iteration-tab.loading {
      border-color: #ffc107;
      background: #fff3cd;
      color: #856404;
    }
    .iteration-tab.success {
      border-color: #28a745;
    }
    .iteration-label {
      font-size: 12px;
      color: #666;
      margin-right: 8px;
      align-self: center;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>Block Generator Test UI</h1>

    <div class="panels">
      <div class="panel">
        <h2>Input</h2>
        <div class="form-group">
          <label for="cfg-gh-url">GitHub Repository URL</label>
          <input type="text" id="cfg-gh-url" placeholder="https://github.com/owner/repo" required>
          <div style="margin-top: 6px; font-size: 11px; color: #888;">
            Session: <span id="sessionIdDisplay">Not started</span> · GitHub token configured in backend
          </div>
        </div>
        <div class="form-group">
          <label for="url">Page URL</label>
          <input type="url" id="url" placeholder="https://example.com/page" required>
        </div>
        <div class="form-group">
          <label for="screenshot">Screenshot (PNG)</label>
          <input type="file" id="screenshot" accept="image/png" required>
        </div>
        <div class="form-group">
          <label for="xpath">Element XPath</label>
          <input type="text" id="xpath" placeholder="/html/body/div[1]/section[2]" required>
        </div>
        <div class="form-group">
          <label for="refinePrompt">Refine Instructions (optional)</label>
          <textarea id="refinePrompt" placeholder="E.g., 'Fix the background gradient - it should be darker' or 'The button should be rounded with more padding'" style="min-height: 60px;"></textarea>
        </div>

        <div class="button-group">
          <button id="generateBtn" onclick="generate()">Generate Block</button>
          <button id="refineBtn" class="refine" onclick="refine()" disabled>Refine</button>
          <button id="winnerBtn" class="winner" onclick="pickWinner()" disabled>Pick Winner</button>
          <button id="designSystemBtn" class="design-system" onclick="importDesignSystem()">Import Design System</button>
          <span class="iteration-count" id="iterationCount"></span>
        </div>
        <div id="status" class="status" style="display: none;"></div>

        <div id="winnerResult" class="winner-result" style="display: none;">
          <h3>🏆 <span id="winnerTitle">Winner</span></h3>
          <div class="reasoning" id="winnerReasoning"></div>
          <div class="scores" id="winnerScores"></div>
          <div id="finalizeSection" style="display: none; margin-top: 12px; padding-top: 12px; border-top: 1px solid #ddd;">
            <button id="finalizeBtn" class="winner" onclick="finalizeWinner()" style="background: #28a745;">Finalize & Merge Winner</button>
            <span id="finalizeStatus" style="margin-left: 10px; font-size: 13px; color: #666;"></span>
          </div>
        </div>

        <div id="screenshotPreview" style="margin-top: 15px; display: none;">
          <label>Screenshot Preview:</label>
          <img id="screenshotImg" style="max-width: 100%; border: 1px solid #ddd; border-radius: 4px;">
        </div>
      </div>

      <div class="panel wide">
        <h2>Generated Block</h2>
        <div class="option-tabs" id="optionTabs" style="display: none;">
          <div class="option-tab active" onclick="switchOption(0)" id="optionTab0">Option 1</div>
          <div class="option-tab" onclick="switchOption(1)" id="optionTab1">Option 2</div>
          <div class="option-tab" onclick="switchOption(2)" id="optionTab2">Option 3</div>
        </div>
        <div class="iteration-tabs" id="iterationTabs" style="display: none;">
          <span class="iteration-label">Iterations:</span>
          <div id="iterationTabsContainer" style="display: flex; gap: 6px;"></div>
        </div>
        <div id="edsPreviewBar" style="display: none; background: #e8f5e9; padding: 8px 12px; border-radius: 4px; margin-bottom: 10px; font-size: 13px;">
          <strong>EDS Preview:</strong> <a id="edsPreviewUrl" href="#" target="_blank" style="color: #2e7d32; word-break: break-all;"></a>
          <span id="edsPreviewStatus" style="margin-left: 10px; color: #666;"></span>
        </div>
        <div class="tabs">
          <div class="tab active" onclick="switchTab('html')">HTML</div>
          <div class="tab" onclick="switchTab('css')">CSS</div>
          <div class="tab" onclick="switchTab('js')">JS</div>
          <div class="tab" onclick="switchTab('designSystem')" id="designSystemTab" style="margin-left: auto; border-left: 1px solid #ddd; padding-left: 20px;">Design System</div>
        </div>
        <div id="htmlTab" class="tab-content active">
          <pre id="generatedHtml">No block generated yet</pre>
        </div>
        <div id="cssTab" class="tab-content">
          <pre id="generatedCss">No block generated yet</pre>
        </div>
        <div id="jsTab" class="tab-content">
          <pre id="generatedJs">No block generated yet</pre>
        </div>
        <div id="designSystemTabContent" class="tab-content">
          <div id="designSystemEmpty" style="color: #888; padding: 40px; text-align: center;">
            Click "Import Design System" to extract design tokens from the Page URL
          </div>
          <div id="designSystemResults" style="display: none;">
            <div id="designSystemCommit" style="margin-bottom: 15px; padding: 10px; background: #e8f5e9; border-radius: 4px; font-size: 13px;"></div>
            <div class="tabs" id="designSubTabs">
              <div class="tab active" onclick="switchDesignSubTab('tokens')">Tokens</div>
              <div class="tab" onclick="switchDesignSubTab('stylesCSS')">styles.css</div>
              <div class="tab" onclick="switchDesignSubTab('fontsCSS')">fonts.css</div>
              <div class="tab" onclick="switchDesignSubTab('preview')" style="margin-left: auto; background: #9c27b0; color: white;">Preview</div>
            </div>
            <div id="tokensSubTab" class="tab-content active">
              <div id="designTokens"></div>
            </div>
            <div id="stylesCSSSubTab" class="tab-content">
              <pre id="designStylesCSS"></pre>
            </div>
            <div id="fontsCSSSubTab" class="tab-content">
              <pre id="designFontsCSS"></pre>
            </div>
            <div id="previewSubTab" class="tab-content">
              <div id="designPreviewLoading" style="color: #888; padding: 40px; text-align: center;">
                Loading preview...
              </div>
              <div id="designPreviewContainer" style="display: none;">
                <div style="margin-bottom: 10px; padding: 8px; background: #f3e5f5; border-radius: 4px; font-size: 13px;">
                  <a id="designPreviewUrl" href="#" target="_blank" style="color: #7b1fa2;">Open preview in new tab →</a>
                </div>
                <div class="viewport-controls" style="margin-bottom: 10px;">
                  <label>Viewport:</label>
                  <button class="viewport-btn active" onclick="setDesignViewport(1440)" data-width="1440">Desktop</button>
                  <button class="viewport-btn" onclick="setDesignViewport(768)" data-width="768">Tablet</button>
                  <button class="viewport-btn" onclick="setDesignViewport(375)" data-width="375">Mobile</button>
                </div>
                <div style="border: 1px solid #ddd; border-radius: 4px; overflow: hidden; background: #f5f5f5;">
                  <div id="designPreviewWrapper" style="width: 100%; height: 600px; margin: 0 auto; transition: width 0.3s; overflow: auto;">
                    <iframe id="designPreviewFrame" style="width: 100%; height: 100%; border: none; background: white;" sandbox="allow-scripts allow-same-origin"></iframe>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div id="imagesRow" class="images-row" style="display: none;">
          <div class="image-box">
            <img id="originalImg" alt="Original">
            <p>Original Screenshot</p>
          </div>
          <div class="image-box">
            <img id="generatedImg" alt="Generated">
            <p>Generated Block</p>
          </div>
        </div>

        <div class="preview-container" id="previewContainer" style="display: none;">
          <div class="preview-header">Live Preview <button onclick="reloadPreview()" style="margin-left: 10px; padding: 2px 8px; font-size: 12px; cursor: pointer;">↻ Reload</button></div>
          <div class="viewport-controls">
            <label>Viewport:</label>
            <button class="viewport-btn active" onclick="setViewport(1440)" data-width="1440">Desktop (1440px)</button>
            <button class="viewport-btn" onclick="setViewport(1024)" data-width="1024">Tablet L (1024px)</button>
            <button class="viewport-btn" onclick="setViewport(768)" data-width="768">Tablet (768px)</button>
            <button class="viewport-btn" onclick="setViewport(375)" data-width="375">Mobile (375px)</button>
            <span class="viewport-size" id="viewportSize">1440px</span>
          </div>
          <div class="preview-content">
            <div class="preview-frame-wrapper" id="previewWrapper" style="width: 1440px;">
              <iframe id="previewFrame" sandbox="allow-scripts allow-same-origin allow-forms allow-popups" allow="scripts"></iframe>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>

  <script>
    // blocks[option][iteration] = block data
    let blocks = [[], [], []];        // Store iterations per option
    let activeOption = 0;             // Currently selected option
    let activeIteration = 0;          // Currently selected iteration within option
    let originalScreenshot = null;
    let currentViewport = 1440;
    let isGenerating = false;         // Prevent multiple generate calls
    let sessionId = null;             // EDS preview session ID
    let edsPreviewEnabled = false;    // Whether to push variants to GitHub/DA
    let selectedWinner = null;        // { option: 1-3, iteration: 1-N } of selected winner

    // Parse GitHub URL: https://github.com/owner/repo -> { owner, repo }
    function parseGitHubUrl(url) {
      if (!url) return null;
      const match = url.match(/github\\.com\\/([^\\/]+)\\/([^\\/]+)/);
      if (match) return { owner: match[1], repo: match[2].replace(/\\.git$/, '') };
      return null;
    }

    // Get EDS config from form (DA org/site derived from GitHub owner/repo, token from backend)
    function getEdsConfig() {
      const ghUrl = document.getElementById('cfg-gh-url').value;
      const ghParsed = parseGitHubUrl(ghUrl);

      // EDS preview is enabled if we have GitHub URL (token comes from backend)
      edsPreviewEnabled = !!ghParsed;

      return {
        github: ghParsed ? { owner: ghParsed.owner, repo: ghParsed.repo } : null,
        // DA org/site = GitHub owner/repo, basePath is always /drafts/gen
        da: ghParsed ? { org: ghParsed.owner, site: ghParsed.repo, basePath: '/drafts/gen' } : null
      };
    }

    // Push a variant to GitHub and DA, return preview URL
    async function pushVariant(block, optionNum, iterationNum) {
      const config = getEdsConfig();
      if (!edsPreviewEnabled) return null;

      try {
        const res = await fetch('/block-variant-push', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sessionId: sessionId,
            blockName: block.blockName || 'block',
            option: optionNum,
            iteration: iterationNum,
            html: block.html,
            css: block.css,
            js: block.js,
            github: config.github,
            da: config.da
          })
        });

        const data = await res.json();
        if (data.success) {
          return data.variant;
        } else {
          console.error('Push variant failed:', data.error);
          return null;
        }
      } catch (err) {
        console.error('Push variant error:', err);
        return null;
      }
    }

    // Set viewport size for preview
    function setViewport(width) {
      currentViewport = width;
      document.getElementById('previewWrapper').style.width = width + 'px';
      document.getElementById('viewportSize').textContent = width + 'px';

      // Update active button
      document.querySelectorAll('.viewport-btn').forEach(btn => {
        btn.classList.remove('active');
        if (parseInt(btn.dataset.width) === width) {
          btn.classList.add('active');
        }
      });
    }

    // Handle screenshot file selection
    document.getElementById('screenshot').addEventListener('change', function(e) {
      const file = e.target.files[0];
      if (file) {
        const reader = new FileReader();
        reader.onload = function(e) {
          document.getElementById('screenshotImg').src = e.target.result;
          document.getElementById('screenshotPreview').style.display = 'block';
          originalScreenshot = file;
        };
        reader.readAsDataURL(file);
      }
    });

    function setStatus(message, type) {
      const status = document.getElementById('status');
      status.textContent = message;
      status.className = 'status ' + type;
      status.style.display = 'block';
    }

    function switchTab(tab) {
      // Clear all tabs in main tab bar
      document.querySelectorAll('.panel.wide > .tabs > .tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.panel.wide > .tab-content').forEach(t => t.classList.remove('active'));

      if (tab === 'designSystem') {
        document.getElementById('designSystemTab').classList.add('active');
        document.getElementById('designSystemTabContent').classList.add('active');
      } else {
        const tabIndex = tab === 'html' ? 1 : tab === 'css' ? 2 : 3;
        document.querySelector('.panel.wide > .tabs > .tab:nth-child(' + tabIndex + ')').classList.add('active');
        document.getElementById(tab + 'Tab').classList.add('active');
      }
    }

    function switchDesignSubTab(tab) {
      document.querySelectorAll('#designSubTabs .tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('#designSystemResults > .tab-content').forEach(t => t.classList.remove('active'));
      const tabIndex = tab === 'tokens' ? 1 : tab === 'stylesCSS' ? 2 : tab === 'fontsCSS' ? 3 : 4;
      document.querySelector('#designSubTabs .tab:nth-child(' + tabIndex + ')').classList.add('active');
      document.getElementById(tab + 'SubTab').classList.add('active');
    }

    function setDesignViewport(width) {
      const wrapper = document.getElementById('designPreviewWrapper');
      wrapper.style.width = width + 'px';
      document.querySelectorAll('#previewSubTab .viewport-btn').forEach(btn => {
        btn.classList.remove('active');
        if (parseInt(btn.dataset.width) === width) {
          btn.classList.add('active');
        }
      });
    }

    // Store design preview info
    let designPreviewUrl = null;
    let designPreviewSessionId = null;

    async function importDesignSystem() {
      const pageUrl = document.getElementById('url').value;
      const ghUrl = document.getElementById('cfg-gh-url').value;

      if (!pageUrl) {
        setStatus('Page URL is required for design system import', 'error');
        return;
      }

      const ghParsed = parseGitHubUrl(ghUrl);

      if (!ghParsed) {
        setStatus('GitHub Repository URL is required for design system import with preview', 'error');
        return;
      }

      const btn = document.getElementById('designSystemBtn');
      btn.disabled = true;
      btn.textContent = 'Importing...';
      setStatus('Extracting design system... This may take 15-30 seconds.', 'loading');

      // Generate session ID for this import
      designPreviewSessionId = 'ds-' + Math.random().toString(36).substring(2, 8);

      try {
        // Step 1: Import design system with preview generation
        const body = {
          url: pageUrl,
          github: ghParsed,
          sessionId: designPreviewSessionId,
          generatePreview: true  // Request preview generation
        };

        const res = await fetch('/design-system-import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });

        const data = await res.json();

        if (!data.success) {
          throw new Error(data.error);
        }

        // Show results
        document.getElementById('designSystemEmpty').style.display = 'none';
        document.getElementById('designSystemResults').style.display = 'block';

        // Commit link
        const commitDiv = document.getElementById('designSystemCommit');
        if (data.github?.commitUrl) {
          commitDiv.innerHTML = '<a href="' + data.github.commitUrl + '" target="_blank" style="color: #2e7d32;">View GitHub Commit →</a> (branch: ' + data.github.branch + ')';
          commitDiv.style.display = 'block';
        }

        // Render tokens
        renderDesignTokens(data.extractedDesign);
        document.getElementById('designStylesCSS').textContent = data.files?.stylesCSS || '';
        document.getElementById('designFontsCSS').textContent = data.files?.fontsCSS || '';

        // Setup preview if available
        if (data.preview?.previewUrl) {
          designPreviewUrl = data.preview.previewUrl;
          document.getElementById('designPreviewUrl').href = designPreviewUrl;
          document.getElementById('designPreviewUrl').textContent = 'Open preview: ' + designPreviewUrl + ' →';
          document.getElementById('designPreviewLoading').style.display = 'none';
          document.getElementById('designPreviewContainer').style.display = 'block';

          // Load preview with delay for CDN propagation
          setTimeout(() => {
            document.getElementById('designPreviewFrame').src = designPreviewUrl;
          }, 3000);
        } else {
          document.getElementById('designPreviewLoading').textContent = 'Preview not available (no DA config)';
        }

        // Switch to design system tab
        switchTab('designSystem');
        setStatus('Design system extracted successfully!', 'success');

      } catch (err) {
        setStatus('Design system import failed: ' + err.message, 'error');
      }

      btn.disabled = false;
      btn.textContent = 'Import Design System';
    }

    function renderDesignTokens(design) {
      if (!design) return;
      let html = '';

      if (design.colors) {
        html += '<div class="design-section"><h4>Colors</h4><div class="color-swatches">';
        for (const [name, value] of Object.entries(design.colors)) {
          html += '<div class="swatch-item"><div class="swatch" style="background:' + value + '"></div>' + name + '</div>';
        }
        html += '</div></div>';
      }

      if (design.typography) {
        html += '<div class="design-section"><h4>Typography</h4>';
        html += '<div class="design-row"><span class="design-label">Body Font</span><span class="design-value">' + design.typography.bodyFont + '</span></div>';
        html += '<div class="design-row"><span class="design-label">Heading Font</span><span class="design-value">' + design.typography.headingFont + '</span></div>';
        html += '<div class="design-row"><span class="design-label">Line Height</span><span class="design-value">' + design.typography.lineHeight + '</span></div>';
        html += '</div>';
      }

      if (design.buttons) {
        html += '<div class="design-section"><h4>Buttons</h4>';
        html += '<div class="design-row"><span class="design-label">Border Radius</span><span class="design-value">' + design.buttons.borderRadius + '</span></div>';
        html += '<div class="design-row"><span class="design-label">Padding</span><span class="design-value">' + design.buttons.padding + '</span></div>';
        if (design.buttons.primary) {
          html += '<div class="design-row"><span class="design-label">Primary BG</span><span class="design-value">' + design.buttons.primary.background + '</span></div>';
        }
        html += '</div>';
      }

      if (design.layout) {
        html += '<div class="design-section"><h4>Layout</h4>';
        html += '<div class="design-row"><span class="design-label">Max Width</span><span class="design-value">' + design.layout.maxWidth + '</span></div>';
        html += '<div class="design-row"><span class="design-label">Nav Height</span><span class="design-value">' + design.layout.navHeight + '</span></div>';
        html += '<div class="design-row"><span class="design-label">Section Padding</span><span class="design-value">' + design.layout.sectionPadding + '</span></div>';
        html += '</div>';
      }

      if (design.fonts && design.fonts.length > 0) {
        html += '<div class="design-section"><h4>Fonts (' + design.fonts.length + ')</h4>';
        design.fonts.forEach(f => {
          html += '<div class="design-row"><span class="design-label">' + f.family + ' (' + f.weight + ')</span><span class="design-value">' + f.localPath + '</span></div>';
        });
        html += '</div>';
      }

      document.getElementById('designTokens').innerHTML = html || '<p style="color:#888;">No tokens extracted</p>';
    }

    function switchOption(index) {
      activeOption = index;
      // Reset to latest iteration for this option
      activeIteration = Math.max(0, blocks[index].length - 1);
      document.querySelectorAll('.option-tab').forEach((t, i) => {
        t.classList.remove('active');
        if (i === index) t.classList.add('active');
      });
      updateIterationTabs();
      displayCurrentBlock();
      updatePreview();
    }

    function switchIteration(index) {
      activeIteration = index;
      document.querySelectorAll('.iteration-tab').forEach((t, i) => {
        t.classList.remove('active');
        if (i === index) t.classList.add('active');
      });
      displayCurrentBlock();
      updatePreview();
    }

    function updateIterationTabs() {
      const container = document.getElementById('iterationTabsContainer');
      const iterations = blocks[activeOption];

      if (iterations.length === 0) {
        document.getElementById('iterationTabs').style.display = 'none';
        return;
      }

      document.getElementById('iterationTabs').style.display = 'flex';

      let html = '';
      for (let i = 0; i < iterations.length; i++) {
        const isActive = i === activeIteration;
        const block = iterations[i];
        const statusClass = block ? (block.loading ? 'loading' : 'success') : '';
        html += '<div class="iteration-tab ' + (isActive ? 'active ' : '') + statusClass + '" onclick="switchIteration(' + i + ')">v' + (i + 1) + '</div>';
      }
      container.innerHTML = html;
    }

    function displayCurrentBlock() {
      const iterations = blocks[activeOption];
      const block = iterations[activeIteration];

      const previewBar = document.getElementById('edsPreviewBar');
      const previewUrlEl = document.getElementById('edsPreviewUrl');
      const previewStatusEl = document.getElementById('edsPreviewStatus');

      if (block && !block.loading) {
        document.getElementById('generatedHtml').textContent = block.html;
        document.getElementById('generatedCss').textContent = block.css;
        document.getElementById('generatedJs').textContent = block.js;
        document.getElementById('iterationCount').textContent = 'Option ' + (activeOption + 1) + ' / v' + (activeIteration + 1);
        document.getElementById('refineBtn').disabled = isGenerating;

        // Show EDS preview URL if available
        if (block.previewUrl) {
          previewBar.style.display = 'block';
          previewUrlEl.href = block.previewUrl;
          previewUrlEl.textContent = block.previewUrl;
          previewStatusEl.textContent = block.branch ? '(branch: ' + block.branch + ')' : '';
        } else {
          previewBar.style.display = 'none';
        }
      } else if (block && block.loading) {
        document.getElementById('generatedHtml').textContent = 'Generating...';
        document.getElementById('generatedCss').textContent = '';
        document.getElementById('generatedJs').textContent = '';
        document.getElementById('refineBtn').disabled = true;
        previewBar.style.display = 'none';
      } else {
        document.getElementById('generatedHtml').textContent = 'No block generated yet';
        document.getElementById('generatedCss').textContent = '';
        document.getElementById('generatedJs').textContent = '';
        document.getElementById('refineBtn').disabled = true;
        previewBar.style.display = 'none';
      }
    }

    function reloadPreview() {
      const iframe = document.getElementById('previewFrame');
      const currentBlock = blocks[activeOption]?.[activeIteration];
      if (currentBlock?.previewUrl && edsPreviewEnabled) {
        // Force reload by clearing and re-setting src
        iframe.removeAttribute('srcdoc');
        iframe.src = '';
        setTimeout(() => {
          iframe.src = currentBlock.previewUrl;
        }, 100);
      }
    }

    function updatePreview() {
      const currentBlock = blocks[activeOption][activeIteration];
      if (!currentBlock || currentBlock.loading) return;

      const iframe = document.getElementById('previewFrame');
      document.getElementById('previewContainer').style.display = 'block';

      // If EDS preview URL is available, use it for real AEM rendering
      if (currentBlock.previewUrl && edsPreviewEnabled) {
        // Remove srcdoc attribute so src takes effect
        iframe.removeAttribute('srcdoc');
        // Add delay to allow CDN to propagate GitHub changes
        // Block files need time to be available on aem.page CDN
        setTimeout(() => {
          iframe.src = currentBlock.previewUrl;
        }, 2000); // 2 second delay for CDN propagation
        return;
      }

      // Fallback: local rendering with srcdoc
      // Transform the JS to extract the decorate function and call it
      // EDS blocks use: export default function decorate(block) { ... }
      // We need to make it callable in the preview
      let jsCode = currentBlock.js || '';

      // Remove 'export default' to make the function accessible
      jsCode = jsCode.replace(/export\\s+default\\s+function\\s+decorate/g, 'function decorate');
      jsCode = jsCode.replace(/export\\s+default\\s+decorate/g, '');

      const previewHtml = \`<!DOCTYPE html>
<html>
<head>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
    \${currentBlock.css}
  </style>
</head>
<body>
  \${currentBlock.html}
  <script>
    \${jsCode}
    // Auto-run decorate if it exists (EDS blocks export a decorate function)
    if (typeof decorate === 'function') {
      // Find the block element - it's the first div child of body (EDS blocks don't have .block class)
      const block = document.querySelector('body > div');
      if (block) {
        try {
          decorate(block);
        } catch (e) {
          console.error('Error running decorate:', e);
        }
      }
    }
  <\\/script>
</body>
</html>\`;

      iframe.src = '';
      iframe.srcdoc = previewHtml;
    }

    async function generate() {
      const ghUrl = document.getElementById('cfg-gh-url').value;
      const url = document.getElementById('url').value;
      const screenshot = document.getElementById('screenshot').files[0];
      const xpath = document.getElementById('xpath').value;

      if (!ghUrl || !url || !screenshot || !xpath) {
        setStatus('Please fill in all required fields: GitHub URL, Page URL, Screenshot, and XPath', 'error');
        return;
      }

      if (!parseGitHubUrl(ghUrl)) {
        setStatus('Invalid GitHub URL format. Use: https://github.com/owner/repo', 'error');
        return;
      }

      if (isGenerating) return;
      isGenerating = true;

      // Reset state
      blocks = [[], [], []];
      activeOption = 0;
      activeIteration = 0;
      sessionId = null;

      // Show option tabs and set all to loading state
      document.getElementById('optionTabs').style.display = 'flex';
      document.getElementById('iterationTabs').style.display = 'none';
      for (let i = 0; i < 3; i++) {
        const tab = document.getElementById('optionTab' + i);
        tab.className = 'option-tab loading' + (i === 0 ? ' active' : '');
      }

      // Get session ID for EDS preview
      getEdsConfig(); // Sets edsPreviewEnabled
      if (edsPreviewEnabled) {
        try {
          const sessionRes = await fetch('/session-id');
          const sessionData = await sessionRes.json();
          sessionId = sessionData.sessionId;
          document.getElementById('sessionIdDisplay').textContent = sessionId;
          setStatus('Session ' + sessionId + ' - Generating 3 options × 3 iterations (3 browser sessions)...', 'loading');
        } catch (e) {
          console.error('Failed to get session ID:', e);
          edsPreviewEnabled = false;
          setStatus('Generating 3 options × 3 iterations (3 browser sessions)...', 'loading');
        }
      } else {
        document.getElementById('sessionIdDisplay').textContent = 'Disabled (no GitHub URL)';
        setStatus('Generating 3 options × 3 iterations (3 browser sessions)...', 'loading');
      }
      document.getElementById('generateBtn').disabled = true;
      document.getElementById('refineBtn').disabled = true;
      document.getElementById('winnerBtn').disabled = true;
      document.getElementById('winnerResult').style.display = 'none';

      // Helper to generate all iterations (initial + refinements) in single browser session
      async function generateFullOption(optionIndex) {
        const formData = new FormData();
        formData.append('url', url);
        formData.append('screenshot', screenshot);
        formData.append('xpath', xpath);
        formData.append('refinements', '2'); // 2 refinement iterations

        const response = await fetch('/block-generate-full', { method: 'POST', body: formData });
        const responseText = await response.text();
        const result = JSON.parse(responseText);

        if (!result.success) throw new Error(result.error);

        // Return all iterations
        return result.iterations.map(iter => ({
          html: iter.html,
          css: iter.css,
          js: iter.js,
          blockName: iter.blockName
        }));
      }

      // Update UI for a specific option/iteration
      function updateUI(optionIndex, iterationIndex, block, isLoading = false, isError = false) {
        blocks[optionIndex][iterationIndex] = isLoading ? { loading: true } : block;

        // Update option tab status
        const optionTab = document.getElementById('optionTab' + optionIndex);
        const hasSuccess = blocks[optionIndex].some(b => b && !b.loading);
        const allDone = blocks[optionIndex].length === 3 && blocks[optionIndex].every(b => b && !b.loading);

        if (isError && !hasSuccess) {
          optionTab.className = 'option-tab error' + (optionIndex === activeOption ? ' active' : '');
        } else if (hasSuccess) {
          optionTab.className = 'option-tab success' + (optionIndex === activeOption ? ' active' : '');
        }

        // If viewing this option, update iteration tabs and display
        if (optionIndex === activeOption) {
          updateIterationTabs();
          if (iterationIndex === activeIteration || (block && activeIteration >= blocks[optionIndex].length)) {
            activeIteration = Math.min(activeIteration, blocks[optionIndex].length - 1);
            displayCurrentBlock();
            updatePreview();
          }
        }
      }

      // Process each option: all iterations in single browser session
      const optionPromises = [0, 1, 2].map(async (optionIndex) => {
        try {
          // Add loading placeholders for all 3 iterations
          updateUI(optionIndex, 0, null, true);
          updateUI(optionIndex, 1, null, true);
          updateUI(optionIndex, 2, null, true);

          // Generate all iterations in single browser session
          const allIterations = await generateFullOption(optionIndex);

          // Process each iteration result
          for (let iterIdx = 0; iterIdx < allIterations.length; iterIdx++) {
            const block = allIterations[iterIdx];

            // Push to GitHub/DA for EDS preview
            if (edsPreviewEnabled && sessionId) {
              const variant = await pushVariant(block, optionIndex + 1, iterIdx + 1);
              if (variant) {
                block.previewUrl = variant.previewUrl;
                block.branch = variant.branch;
                block.daPath = variant.daPath;
              }
            }
            updateUI(optionIndex, iterIdx, block);
          }

          return { success: true, optionIndex };
        } catch (error) {
          console.error('Generation error for option ' + optionIndex + ':', error);
          updateUI(optionIndex, 0, null, false, true);
          // Clear loading placeholders on error
          blocks[optionIndex] = [];
          updateIterationTabs();
          return { success: false, optionIndex, error: error.message };
        }
      });

      // Wait for all to complete
      const results = await Promise.all(optionPromises);
      const successCount = results.filter(r => r.success).length;

      isGenerating = false;
      document.getElementById('generateBtn').disabled = false;

      // Count total successful iterations
      const totalIterations = blocks.reduce((sum, opt) => sum + opt.filter(b => b && !b.loading).length, 0);

      if (successCount === 0) {
        setStatus('All generations failed: ' + results[0].error, 'error');
      } else {
        setStatus(totalIterations + ' blocks generated across ' + successCount + ' options!', 'success');
      }

      // Enable refine if current option has a block
      const currentBlock = blocks[activeOption][activeIteration];
      if (currentBlock && !currentBlock.loading) {
        document.getElementById('refineBtn').disabled = false;
      }

      // Enable winner button if at least 2 options have blocks
      const optionsWithBlocks = blocks.filter(opt => opt.some(b => b && !b.loading)).length;
      if (optionsWithBlocks >= 2) {
        document.getElementById('winnerBtn').disabled = false;
      }
    }

    async function refine() {
      const currentBlock = blocks[activeOption][activeIteration];
      if (!currentBlock || currentBlock.loading || !originalScreenshot) {
        setStatus('Please select a valid block first', 'error');
        return;
      }

      const url = document.getElementById('url').value;
      const html = document.getElementById('html').value;
      const xpath = document.getElementById('xpath').value;
      const refinePrompt = document.getElementById('refinePrompt').value;

      const newIterIndex = blocks[activeOption].length;
      setStatus('Refining Option ' + (activeOption + 1) + ' → v' + (newIterIndex + 1) + '...', 'loading');
      document.getElementById('refineBtn').disabled = true;

      // Add loading placeholder
      blocks[activeOption].push({ loading: true });
      activeIteration = newIterIndex;
      updateIterationTabs();
      displayCurrentBlock();

      try {
        const formData = new FormData();
        formData.append('url', url);
        formData.append('screenshot', originalScreenshot);
        formData.append('xpath', xpath);
        if (refinePrompt) formData.append('prompt', refinePrompt);
        formData.append('blockHtml', currentBlock.html);
        formData.append('blockCss', currentBlock.css);
        formData.append('blockJs', currentBlock.js);
        formData.append('blockName', currentBlock.blockName || 'block');

        const response = await fetch('/block-refine', {
          method: 'POST',
          body: formData
        });

        const responseText = await response.text();
        let result;
        try {
          result = JSON.parse(responseText);
        } catch (parseError) {
          console.error('Non-JSON response:', responseText.substring(0, 500));
          throw new Error('Server returned non-JSON response');
        }

        if (result.success) {
          const newBlock = {
            html: result.html,
            css: result.css,
            js: result.js,
            blockName: result.blockName
          };

          // Push to GitHub/DA for EDS preview
          if (edsPreviewEnabled && sessionId) {
            const variant = await pushVariant(newBlock, activeOption + 1, newIterIndex + 1);
            if (variant) {
              newBlock.previewUrl = variant.previewUrl;
              newBlock.branch = variant.branch;
              newBlock.daPath = variant.daPath;
            }
          }

          blocks[activeOption][newIterIndex] = newBlock;

          updateIterationTabs();
          displayCurrentBlock();

          // Show comparison images
          document.getElementById('imagesRow').style.display = 'grid';
          document.getElementById('originalImg').src = document.getElementById('screenshotImg').src;
          if (result.generatedScreenshot) {
            document.getElementById('generatedImg').src = 'data:image/png;base64,' + result.generatedScreenshot;
          }

          updatePreview();
          setStatus('Option ' + (activeOption + 1) + ' v' + (newIterIndex + 1) + ' created! ' + (result.refinementNotes || ''), 'success');
        } else {
          throw new Error(result.error);
        }
      } catch (error) {
        // Remove loading placeholder on error
        blocks[activeOption].pop();
        activeIteration = blocks[activeOption].length - 1;
        updateIterationTabs();
        displayCurrentBlock();
        setStatus('Error: ' + error.message, 'error');
      } finally {
        document.getElementById('refineBtn').disabled = false;
      }
    }

    async function pickWinner() {
      // Get the latest iteration for each option that has blocks
      const latestBlocks = [];
      for (let i = 0; i < 3; i++) {
        const optionBlocks = blocks[i];
        if (optionBlocks.length > 0) {
          const latestBlock = optionBlocks[optionBlocks.length - 1];
          if (latestBlock && !latestBlock.loading) {
            latestBlocks.push({
              html: latestBlock.html,
              css: latestBlock.css,
              js: latestBlock.js,
              blockName: latestBlock.blockName,
              optionIndex: i,
              // Include EDS preview URL for real AEM rendering comparison
              previewUrl: latestBlock.previewUrl || null
            });
          }
        }
      }

      if (latestBlocks.length < 2) {
        setStatus('Need at least 2 options to pick a winner', 'error');
        return;
      }

      if (!originalScreenshot) {
        setStatus('No original screenshot available', 'error');
        return;
      }

      setStatus('Analyzing ' + latestBlocks.length + ' options with Claude Vision...', 'loading');
      document.getElementById('winnerBtn').disabled = true;
      document.getElementById('winnerResult').style.display = 'none';

      try {
        const formData = new FormData();
        formData.append('screenshot', originalScreenshot);
        formData.append('blocks', JSON.stringify(latestBlocks));

        const response = await fetch('/block-winner', {
          method: 'POST',
          body: formData
        });

        const result = await response.json();

        if (result.success) {
          // Show the winner result
          const winnerResult = document.getElementById('winnerResult');
          winnerResult.style.display = 'block';

          document.getElementById('winnerTitle').textContent =
            'Winner: Option ' + (result.winner.optionIndex + 1) + ' (Confidence: ' + result.confidence + '%)';
          document.getElementById('winnerReasoning').textContent = result.reasoning;

          // Build score cards
          let scoresHtml = '';
          for (const score of result.scores) {
            const isWinner = score.option === (result.winner.optionIndex + 1);
            scoresHtml += '<div class="score-card' + (isWinner ? ' winner' : '') + '">';
            scoresHtml += '<div class="option-name">Option ' + score.option + '</div>';
            scoresHtml += '<div class="score">' + score.score + '</div>';
            scoresHtml += '<div class="notes">' + score.notes + '</div>';
            scoresHtml += '</div>';
          }
          document.getElementById('winnerScores').innerHTML = scoresHtml;

          // Switch to the winning option/iteration
          const winnerOptionIndex = result.winner.optionIndex;
          const winnerIterationIndex = blocks[winnerOptionIndex].length - 1;
          activeOption = winnerOptionIndex;
          activeIteration = winnerIterationIndex;

          // Store the winner for finalization
          selectedWinner = {
            option: winnerOptionIndex + 1,
            iteration: winnerIterationIndex + 1
          };

          // Show finalize button if EDS preview is enabled
          const finalizeSection = document.getElementById('finalizeSection');
          if (edsPreviewEnabled && sessionId) {
            finalizeSection.style.display = 'block';
            document.getElementById('finalizeStatus').textContent = '';
          } else {
            finalizeSection.style.display = 'none';
          }

          // Update UI to show the winner
          document.querySelectorAll('.option-tab').forEach((t, i) => {
            t.classList.remove('active');
            if (i === winnerOptionIndex) t.classList.add('active');
          });
          updateIterationTabs();
          displayCurrentBlock();
          updatePreview();

          setStatus('Winner selected: Option ' + (winnerOptionIndex + 1) + '!', 'success');
        } else {
          throw new Error(result.error);
        }
      } catch (error) {
        setStatus('Error picking winner: ' + error.message, 'error');
      } finally {
        document.getElementById('winnerBtn').disabled = false;
      }
    }

    async function finalizeWinner() {
      if (!selectedWinner || !sessionId || !edsPreviewEnabled) {
        setStatus('No winner selected or EDS preview not enabled', 'error');
        return;
      }

      const winnerBlock = blocks[selectedWinner.option - 1][selectedWinner.iteration - 1];
      if (!winnerBlock || winnerBlock.loading) {
        setStatus('Winner block not available', 'error');
        return;
      }

      const config = getEdsConfig();
      const btn = document.getElementById('finalizeBtn');
      const statusEl = document.getElementById('finalizeStatus');

      btn.disabled = true;
      btn.textContent = 'Finalizing...';
      statusEl.textContent = 'Merging winner branch and cleaning up...';
      setStatus('Finalizing winner: merging to main...', 'loading');

      try {
        const res = await fetch('/block-finalize', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sessionId: sessionId,
            blockName: winnerBlock.blockName || 'block',
            winner: selectedWinner,
            github: config.github,
            da: config.da,
            cleanup: true
          })
        });

        const data = await res.json();

        if (data.success) {
          let statusHtml = 'Merged to <strong>' + data.merged.into + '</strong>!<br>';
          statusHtml += '<a href="' + data.merged.commitUrl + '" target="_blank" style="color: #007bff;">View GitHub commit →</a>';

          if (data.library) {
            statusHtml += '<br><a href="' + data.library.previewUrl + '" target="_blank" style="color: #007bff;">View block in library →</a>';
            statusHtml += ' (<a href="' + data.library.daUrl + '" target="_blank" style="color: #6c757d; font-size: 12px;">edit in DA</a>)';
          }

          if (data.cleanup) {
            statusHtml += '<br><span style="font-size: 12px; color: #666;">Cleaned up ' + data.cleanup.branchesDeleted + ' branches, ' + data.cleanup.pagesDeleted + ' pages.</span>';
          }

          statusEl.innerHTML = statusHtml;
          statusEl.style.color = '#28a745';
          btn.textContent = 'Finalized';
          btn.style.background = '#6c757d';
          setStatus('Winner finalized! Block merged and added to library.', 'success');
        } else {
          throw new Error(data.error);
        }
      } catch (err) {
        statusEl.textContent = 'Error: ' + err.message;
        statusEl.style.color = '#dc3545';
        btn.disabled = false;
        btn.textContent = 'Finalize & Merge Winner';
        setStatus('Error finalizing: ' + err.message, 'error');
      }
    }

  </script>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: {
      'Access-Control-Allow-Origin': env.ALLOWED_ORIGINS || '*',
      'Content-Type': 'text/html; charset=utf-8',
    },
  });
}

/**
 * Returns the test UI HTML page with block generation and design system import
 */
function handleTestUI(env: Env): Response {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>EDS Block Generator</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
      min-height: 100vh;
      padding: 20px;
      color: #fff;
    }
    .container { max-width: 1400px; margin: 0 auto; }
    h1 { margin-bottom: 8px; font-size: 28px; }
    .subtitle { color: #888; margin-bottom: 24px; }
    .main-layout { display: grid; grid-template-columns: 380px 1fr; gap: 20px; }
    @media (max-width: 900px) { .main-layout { grid-template-columns: 1fr; } }
    .panel {
      background: rgba(255,255,255,0.05);
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 12px;
      padding: 20px;
    }
    .panel h2 { font-size: 16px; margin-bottom: 16px; color: #aaa; }
    .form-group { margin-bottom: 14px; }
    label { display: block; font-weight: 500; margin-bottom: 6px; font-size: 13px; color: #aaa; }
    input[type="text"], input[type="password"], input[type="url"] {
      width: 100%;
      padding: 10px 12px;
      font-size: 14px;
      border: 1px solid rgba(255,255,255,0.15);
      border-radius: 6px;
      background: rgba(0,0,0,0.3);
      color: #fff;
    }
    input:focus {
      outline: none;
      border-color: #3b63fb;
    }
    .hint { font-size: 11px; color: #666; margin-top: 4px; }
    .section-divider {
      border-top: 1px solid rgba(255,255,255,0.1);
      margin: 20px 0 16px;
      padding-top: 16px;
    }
    .section-title { font-size: 13px; color: #888; margin-bottom: 12px; text-transform: uppercase; letter-spacing: 0.5px; }
    .row { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .checkbox-group { display: flex; align-items: center; gap: 8px; margin-top: 4px; }
    .checkbox-group input { width: 16px; height: 16px; cursor: pointer; }
    .checkbox-group label { margin: 0; cursor: pointer; color: #ccc; font-size: 13px; }
    .buttons { display: flex; flex-direction: column; gap: 10px; margin-top: 20px; }
    button {
      padding: 12px 20px;
      font-size: 14px;
      font-weight: 600;
      border: none;
      border-radius: 6px;
      cursor: pointer;
      transition: all 0.2s;
      width: 100%;
    }
    button:hover { transform: translateY(-1px); }
    button:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }
    .btn-primary { background: #3b63fb; color: white; }
    .btn-primary:hover { background: #1d3ecf; }
    .btn-secondary { background: rgba(255,255,255,0.1); color: #ccc; border: 1px solid rgba(255,255,255,0.2); }
    .btn-secondary:hover { background: rgba(255,255,255,0.15); }
    .btn-design { background: linear-gradient(135deg, #9c27b0 0%, #7b1fa2 100%); color: white; }
    .btn-design:hover { background: linear-gradient(135deg, #7b1fa2 0%, #6a1b9a 100%); }
    .btn-row { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .status {
      margin-top: 12px;
      padding: 10px;
      border-radius: 6px;
      font-size: 13px;
      display: none;
    }
    .status.loading { display: block; background: rgba(59,99,251,0.2); border: 1px solid #3b63fb; }
    .status.error { display: block; background: rgba(244,67,54,0.2); border: 1px solid #f44336; }
    .status.success { display: block; background: rgba(76,175,80,0.2); border: 1px solid #4CAF50; }
    /* Right panel */
    .results-panel { max-height: calc(100vh - 100px); overflow-y: auto; }
    .tabs { display: flex; gap: 8px; margin-bottom: 16px; }
    .tab {
      padding: 8px 16px;
      background: rgba(255,255,255,0.1);
      border: 1px solid rgba(255,255,255,0.2);
      border-radius: 6px;
      color: #888;
      font-size: 13px;
      cursor: pointer;
      width: auto;
    }
    .tab:hover { background: rgba(255,255,255,0.15); transform: none; }
    .tab.active { background: rgba(59,99,251,0.3); border-color: #3b63fb; color: #fff; }
    .tab.design-active { background: rgba(156,39,176,0.3); border-color: #9c27b0; }
    .tab-content { display: none; }
    .tab-content.active { display: block; }
    .empty-state { text-align: center; padding: 60px 20px; color: #555; }
    .empty-state .icon { font-size: 48px; margin-bottom: 16px; opacity: 0.5; }
    pre {
      background: rgba(0,0,0,0.4);
      padding: 16px;
      border-radius: 8px;
      overflow-x: auto;
      font-size: 12px;
      line-height: 1.5;
      white-space: pre-wrap;
      word-break: break-word;
      color: #ccc;
    }
    .design-section { margin-bottom: 20px; padding: 14px; background: rgba(0,0,0,0.2); border-radius: 8px; }
    .design-section h3 { font-size: 12px; color: #9c27b0; margin-bottom: 10px; text-transform: uppercase; letter-spacing: 1px; }
    .color-swatches { display: flex; flex-wrap: wrap; gap: 6px; }
    .swatch-item { display: flex; align-items: center; gap: 6px; padding: 4px 8px; background: rgba(0,0,0,0.3); border-radius: 4px; font-size: 12px; }
    .swatch { width: 20px; height: 20px; border-radius: 4px; border: 1px solid rgba(255,255,255,0.2); }
    .design-row { display: flex; justify-content: space-between; padding: 5px 0; border-bottom: 1px solid rgba(255,255,255,0.05); font-size: 13px; }
    .design-row:last-child { border-bottom: none; }
    .design-label { color: #888; }
    .design-value { font-family: monospace; color: #fff; }
    .design-tabs { display: flex; gap: 6px; margin-bottom: 12px; }
    .design-tab { padding: 6px 12px; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); border-radius: 4px; color: #888; font-size: 12px; cursor: pointer; width: auto; }
    .design-tab:hover { background: rgba(255,255,255,0.1); transform: none; }
    .design-tab.active { background: rgba(156,39,176,0.2); border-color: #9c27b0; color: #fff; }
    .design-subtab { display: none; }
    .design-subtab.active { display: block; }
    .commit-link { margin-top: 12px; }
    .commit-link a { color: #4CAF50; text-decoration: none; }
    .commit-link a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="container">
    <h1>EDS Block Generator</h1>
    <p class="subtitle">Generate blocks and import design systems from any webpage</p>

    <div class="main-layout">
      <!-- Left Panel - Input Form -->
      <div class="panel">
        <h2>Configuration</h2>

        <div class="form-group">
          <label>Page URL</label>
          <input type="url" id="url" placeholder="https://example.com" required>
          <p class="hint">The webpage to extract from</p>
        </div>

        <div class="form-group">
          <label>CSS Selector (for block generation)</label>
          <input type="text" id="selector" placeholder=".hero, #main-content">
          <p class="hint">CSS selector for block content</p>
        </div>

        <div class="btn-row">
          <button type="button" class="btn-primary" id="previewBtn">Preview Block</button>
          <button type="button" class="btn-secondary" id="jsonBtn">Get JSON</button>
        </div>

        <div class="section-divider">
          <div class="section-title">GitHub Configuration</div>
        </div>

        <div class="row">
          <div class="form-group">
            <label>Owner</label>
            <input type="text" id="gh-owner" value="paolomoz">
          </div>
          <div class="form-group">
            <label>Repo</label>
            <input type="text" id="gh-repo" value="neocat-2">
          </div>
        </div>

        <div class="form-group">
          <label>GitHub Token</label>
          <input type="password" id="gh-token" placeholder="ghp_...">
        </div>

        <div class="form-group">
          <div class="checkbox-group">
            <input type="checkbox" id="dry-run" checked>
            <label for="dry-run">Dry Run (don't push)</label>
          </div>
        </div>

        <div class="buttons">
          <button type="button" class="btn-design" id="importDesignBtn">Import Design System</button>
        </div>

        <div id="status" class="status"></div>
      </div>

      <!-- Right Panel - Results -->
      <div class="panel results-panel">
        <div class="tabs">
          <button class="tab active" data-tab="block">Block Results</button>
          <button class="tab" data-tab="design">Design System</button>
        </div>

        <div id="tab-block" class="tab-content active">
          <div id="block-empty" class="empty-state">
            <div class="icon">&#128230;</div>
            <p>Enter a URL and selector, then click Preview or Get JSON</p>
          </div>
          <div id="block-results" style="display:none;">
            <pre id="block-json"></pre>
          </div>
        </div>

        <div id="tab-design" class="tab-content">
          <div id="design-empty" class="empty-state">
            <div class="icon">&#127912;</div>
            <p>Enter a URL and click Import Design System</p>
          </div>
          <div id="design-results" style="display:none;">
            <div id="design-commit" class="commit-link"></div>
            <div class="design-tabs">
              <button class="design-tab active" data-subtab="tokens">Tokens</button>
              <button class="design-tab" data-subtab="styles">styles.css</button>
              <button class="design-tab" data-subtab="fonts">fonts.css</button>
              <button class="design-tab" data-subtab="json">JSON</button>
            </div>
            <div id="subtab-tokens" class="design-subtab active"></div>
            <div id="subtab-styles" class="design-subtab"><pre id="styles-css"></pre></div>
            <div id="subtab-fonts" class="design-subtab"><pre id="fonts-css"></pre></div>
            <div id="subtab-json" class="design-subtab"><pre id="design-json"></pre></div>
          </div>
        </div>
      </div>
    </div>
  </div>

  <script>
    // Load saved GitHub config
    ['gh-owner', 'gh-repo', 'gh-token'].forEach(id => {
      const saved = localStorage.getItem('eds-test-' + id);
      if (saved) document.getElementById(id).value = saved;
    });

    // Save GitHub config on change
    ['gh-owner', 'gh-repo', 'gh-token'].forEach(id => {
      document.getElementById(id).addEventListener('change', (e) => {
        localStorage.setItem('eds-test-' + id, e.target.value);
      });
    });

    // Tab switching
    document.querySelectorAll('.tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active', 'design-active'));
        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
        tab.classList.add('active');
        if (tab.dataset.tab === 'design') tab.classList.add('design-active');
        document.getElementById('tab-' + tab.dataset.tab).classList.add('active');
      });
    });

    // Design subtab switching
    document.querySelectorAll('.design-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.design-tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.design-subtab').forEach(c => c.classList.remove('active'));
        tab.classList.add('active');
        document.getElementById('subtab-' + tab.dataset.subtab).classList.add('active');
      });
    });

    const status = document.getElementById('status');

    function showStatus(type, message) {
      status.className = 'status ' + type;
      status.innerHTML = message;
    }

    function hideStatus() {
      status.className = 'status';
      status.style.display = 'none';
    }

    // Block Preview
    document.getElementById('previewBtn').addEventListener('click', async () => {
      const url = document.getElementById('url').value;
      const selector = document.getElementById('selector').value;
      if (!url || !selector) { showStatus('error', 'URL and selector required'); return; }

      showStatus('loading', 'Generating preview...');
      try {
        const res = await fetch('/preview', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url, selector })
        });
        const html = await res.text();
        if (!res.ok) throw new Error('Failed to generate preview');
        const win = window.open('', '_blank');
        if (!win) throw new Error('Popup blocked');
        win.document.write(html);
        win.document.close();
        hideStatus();
      } catch (err) {
        showStatus('error', err.message);
      }
    });

    // Block JSON
    document.getElementById('jsonBtn').addEventListener('click', async () => {
      const url = document.getElementById('url').value;
      const selector = document.getElementById('selector').value;
      if (!url || !selector) { showStatus('error', 'URL and selector required'); return; }

      showStatus('loading', 'Generating JSON...');
      try {
        const res = await fetch('/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url, selector })
        });
        const json = await res.json();
        if (!json.success) throw new Error(json.error);

        document.getElementById('block-empty').style.display = 'none';
        document.getElementById('block-results').style.display = 'block';
        document.getElementById('block-json').textContent = JSON.stringify(json, null, 2);

        // Switch to block tab
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active', 'design-active'));
        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
        document.querySelector('[data-tab="block"]').classList.add('active');
        document.getElementById('tab-block').classList.add('active');

        hideStatus();
      } catch (err) {
        showStatus('error', err.message);
      }
    });

    // Design System Import
    document.getElementById('importDesignBtn').addEventListener('click', async () => {
      const url = document.getElementById('url').value;
      if (!url) { showStatus('error', 'URL required'); return; }

      const btn = document.getElementById('importDesignBtn');
      btn.disabled = true;
      btn.textContent = 'Extracting...';
      showStatus('loading', 'Extracting design system... This may take 15-30 seconds.');

      try {
        const body = {
          url,
          github: {
            owner: document.getElementById('gh-owner').value,
            repo: document.getElementById('gh-repo').value,
          },
          dryRun: document.getElementById('dry-run').checked,
        };
        const token = document.getElementById('gh-token').value;
        if (token) body.github.token = token;

        const res = await fetch('/design-system-import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });

        const data = await res.json();
        if (!data.success) throw new Error(data.error);

        // Show results
        document.getElementById('design-empty').style.display = 'none';
        document.getElementById('design-results').style.display = 'block';

        // Commit link
        const commitDiv = document.getElementById('design-commit');
        if (data.github?.commitUrl) {
          commitDiv.innerHTML = '<a href="' + data.github.commitUrl + '" target="_blank">View GitHub Commit &rarr;</a>';
        } else {
          commitDiv.innerHTML = '<span style="color:#888;">Dry run - not pushed to GitHub</span>';
        }

        // Render tokens
        renderDesignTokens(data.extractedDesign);
        document.getElementById('styles-css').textContent = data.files?.stylesCSS || '';
        document.getElementById('fonts-css').textContent = data.files?.fontsCSS || '';
        document.getElementById('design-json').textContent = JSON.stringify(data, null, 2);

        // Switch to design tab
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active', 'design-active'));
        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
        document.querySelector('[data-tab="design"]').classList.add('active', 'design-active');
        document.getElementById('tab-design').classList.add('active');

        showStatus('success', 'Design system extracted successfully!');
      } catch (err) {
        showStatus('error', err.message);
      }

      btn.disabled = false;
      btn.textContent = 'Import Design System';
    });

    function renderDesignTokens(design) {
      if (!design) return;
      let html = '';

      if (design.colors) {
        html += '<div class="design-section"><h3>Colors</h3><div class="color-swatches">';
        for (const [name, value] of Object.entries(design.colors)) {
          html += '<div class="swatch-item"><div class="swatch" style="background:' + value + '"></div>' + name + ': ' + value + '</div>';
        }
        html += '</div></div>';
      }

      if (design.typography) {
        html += '<div class="design-section"><h3>Typography</h3>';
        html += '<div class="design-row"><span class="design-label">Body Font</span><span class="design-value">' + design.typography.bodyFont + '</span></div>';
        html += '<div class="design-row"><span class="design-label">Heading Font</span><span class="design-value">' + design.typography.headingFont + '</span></div>';
        html += '<div class="design-row"><span class="design-label">Line Height</span><span class="design-value">' + design.typography.lineHeight + '</span></div>';
        html += '</div>';
      }

      if (design.buttons) {
        html += '<div class="design-section"><h3>Buttons</h3>';
        html += '<div class="design-row"><span class="design-label">Border Radius</span><span class="design-value">' + design.buttons.borderRadius + '</span></div>';
        html += '<div class="design-row"><span class="design-label">Padding</span><span class="design-value">' + design.buttons.padding + '</span></div>';
        if (design.buttons.primary) {
          html += '<div class="design-row"><span class="design-label">Primary BG</span><span class="design-value">' + design.buttons.primary.background + '</span></div>';
        }
        html += '</div>';
      }

      if (design.layout) {
        html += '<div class="design-section"><h3>Layout</h3>';
        html += '<div class="design-row"><span class="design-label">Max Width</span><span class="design-value">' + design.layout.maxWidth + '</span></div>';
        html += '<div class="design-row"><span class="design-label">Nav Height</span><span class="design-value">' + design.layout.navHeight + '</span></div>';
        html += '<div class="design-row"><span class="design-label">Section Padding</span><span class="design-value">' + design.layout.sectionPadding + '</span></div>';
        html += '</div>';
      }

      if (design.fonts && design.fonts.length > 0) {
        html += '<div class="design-section"><h3>Fonts (' + design.fonts.length + ')</h3>';
        design.fonts.forEach(f => {
          html += '<div class="design-row"><span class="design-label">' + f.family + ' (' + f.weight + ')</span><span class="design-value">' + f.localPath + '</span></div>';
        });
        html += '</div>';
      }

      document.getElementById('subtab-tokens').innerHTML = html || '<p style="color:#888;">No tokens extracted</p>';
    }
  </script>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

/**
 * Debug endpoint to view visual section analysis results
 * Shows Claude's visual section identification with Y-boundaries and CSS selectors
 */
async function handleDebugBboxes(request: Request, env: Env): Promise<Response> {
  try {
    const body = await request.json() as { url?: string };
    const url = body?.url;

    if (typeof url !== 'string' || !url.trim()) {
      return Response.json(
        { success: false, error: 'Missing or invalid "url" field', code: 'INVALID_REQUEST' },
        { status: 400, headers: corsHeaders(env) }
      );
    }

    if (!env.BROWSER) {
      return Response.json(
        { success: false, error: 'Browser Rendering not configured', code: 'CONFIG_ERROR' },
        { status: 500, headers: corsHeaders(env) }
      );
    }

    const anthropicConfig = getAnthropicConfig(env);
    if (!anthropicConfig) {
      return Response.json(
        { success: false, error: 'Claude API not configured', code: 'CONFIG_ERROR' },
        { status: 500, headers: corsHeaders(env) }
      );
    }

    const browser = await puppeteer.launch(env.BROWSER);
    try {
      const page = await browser.newPage();

      // Use visual-first section analysis (like identify-page-structure skill)
      const result = await analyzePage(page, url.trim(), anthropicConfig);

      const colors = ['#e63946', '#2a9d8f', '#e9c46a', '#264653', '#f4a261', '#9b5de5'];

      // Return HTML page showing sections (description-based, no coordinates)
      const html = `<!DOCTYPE html>
<html>
<head>
  <title>Visual Section Analysis: ${url}</title>
  <style>
    body { font-family: system-ui; padding: 20px; background: #f5f5f5; }
    h1 { margin-bottom: 8px; }
    .url { color: #666; margin-bottom: 20px; font-size: 14px; word-break: break-all; }
    .page-info { background: #fff; padding: 16px; margin-bottom: 20px; border-radius: 8px; }
    .screenshot-container { position: relative; display: inline-block; margin-bottom: 30px; }
    .screenshot-container img { max-width: 100%; border: 2px solid #333; }
    .blocks-section { margin-top: 30px; }
    .section-card { background: #fff; border-radius: 8px; padding: 16px; margin-bottom: 16px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
    .section-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 12px; }
    .section-name { font-size: 18px; font-weight: 600; margin: 0; }
    .section-badges { display: flex; gap: 8px; flex-wrap: wrap; }
    .badge { padding: 4px 10px; border-radius: 4px; font-size: 12px; }
    .badge.type { background: #e0e0e0; }
    .badge.style { background: #17a2b8; color: white; }
    .badge.high { background: #dc3545; color: white; }
    .badge.medium { background: #ffc107; color: #333; }
    .badge.low { background: #6c757d; color: white; }
    .section-desc { color: #333; font-size: 14px; line-height: 1.5; background: #f9f9f9; padding: 12px; border-radius: 6px; border-left: 4px solid #17a2b8; }
  </style>
</head>
<body>
  <h1>Visual Section Analysis</h1>
  <p class="url">${url}</p>

  <div class="page-info">
    <strong>Page Dimensions:</strong> ${result.pageWidth}px × ${result.pageHeight}px<br>
    <strong>Sections Identified:</strong> ${result.sections.length}<br>
    <strong>Method:</strong> Description-based (Claude identifies sections by visual description)
  </div>

  <h2>Full Page Screenshot</h2>
  <div class="screenshot-container">
    <img src="data:image/png;base64,${result.screenshot}" />
  </div>

  <div class="blocks-section">
    <h2>Identified Sections (${result.sections.length})</h2>
    ${result.sections.map((s, i) => `
      <div class="section-card">
        <div class="section-header">
          <h3 class="section-name">${i + 1}. ${s.name}</h3>
          <div class="section-badges">
            <span class="badge type">${s.type}</span>
            <span class="badge style">${s.style}</span>
            <span class="badge ${s.priority}">${s.priority}</span>
          </div>
        </div>
        <p class="section-desc">${s.description}</p>
      </div>
    `).join('')}
  </div>
</body>
</html>`;

      return new Response(html, {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    } finally {
      await browser.close();
    }
  } catch (error) {
    console.error('Debug visual analysis failed:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return Response.json(
      { success: false, error: message, code: 'DEBUG_ERROR' },
      { status: 500, headers: corsHeaders(env) }
    );
  }
}

/**
 * Debug: Show what we extract for a specific section based on Y-boundaries
 */
async function handleDebugSection(request: Request, env: Env): Promise<Response> {
  try {
    const body = await request.json() as {
      url?: string;
      sectionName?: string;
      sectionDescription?: string;
      yStart?: number;
      yEnd?: number;
    };

    const { url, sectionName, sectionDescription, yStart, yEnd } = body;

    if (!url || !sectionName || yStart === undefined || yEnd === undefined) {
      return Response.json(
        { success: false, error: 'Missing required fields: url, sectionName, yStart, yEnd' },
        { status: 400, headers: corsHeaders(env) }
      );
    }

    if (!env.BROWSER) {
      return Response.json(
        { success: false, error: 'Browser Rendering not configured' },
        { status: 500, headers: corsHeaders(env) }
      );
    }

    const browser = await puppeteer.launch(env.BROWSER);
    try {
      const page = await browser.newPage();
      await page.setViewport({ width: 1440, height: 900 });
      // Set desktop user agent to ensure desktop layout
      await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await new Promise(r => setTimeout(r, 2000));

      // Dismiss cookie consent banners before screenshots
      try {
        await dismissCookieBanners(page);
      } catch (e) {
        console.log('Cookie dismissal error:', e);
      }

      // Scroll to load lazy content
      await page.evaluate(async () => {
        const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
        for (let pass = 0; pass < 2; pass++) {
          const scrollHeight = document.documentElement.scrollHeight;
          const viewportHeight = window.innerHeight;
          const scrollStep = viewportHeight * 0.7;
          let pos = 0;
          while (pos < scrollHeight) {
            window.scrollTo(0, pos);
            await delay(200);
            pos += scrollStep;
          }
          window.scrollTo(0, scrollHeight);
          await delay(500);
        }
        window.scrollTo(0, 0);
      });
      await new Promise(r => setTimeout(r, 1500));

      const dimensions = await page.evaluate(() => ({
        width: document.documentElement.scrollWidth,
        height: document.documentElement.scrollHeight,
      }));

      // Find DOM element at Y position (same improved algorithm as generation)
      const sectionData = await page.evaluate((yS: number, yE: number) => {
        const targetHeight = yE - yS;
        window.scrollTo(0, Math.max(0, yS - 100));

        const allElements = document.querySelectorAll('body *');
        const candidates: { el: Element; score: number; elTop: number; elHeight: number }[] = [];

        for (const el of allElements) {
          const rect = el.getBoundingClientRect();
          const elTop = rect.top + window.scrollY;
          const elBottom = elTop + rect.height;

          if (rect.width < 100 || rect.height < 30) continue;
          if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'META', 'LINK', 'BR', 'HR'].includes(el.tagName)) continue;

          const overlapStart = Math.max(yS, elTop);
          const overlapEnd = Math.min(yE, elBottom);
          const overlap = Math.max(0, overlapEnd - overlapStart);

          if (overlap > 0) {
            // Score based on how well the element MATCHES the target range
            const rangeCoverage = overlap / targetHeight;

            // Penalize elements that don't match target size (too large OR too small)
            const sizeRatio = rect.height / targetHeight;
            let sizePenalty = 1;
            if (sizeRatio > 2) {
              sizePenalty = Math.max(0.2, 1 / Math.sqrt(sizeRatio));
            } else if (sizeRatio < 0.5) {
              sizePenalty = Math.max(0.3, sizeRatio * 1.5);
            }

            // Boundary matching - element should START and END near target
            const startDiff = Math.abs(elTop - yS) / targetHeight;
            const endDiff = Math.abs(elBottom - yE) / targetHeight;
            const boundaryPenalty = Math.max(0.3, 1 - (startDiff + endDiff) * 0.4);

            let score = rangeCoverage * sizePenalty * boundaryPenalty;

            const isSection = ['SECTION', 'ARTICLE', 'MAIN'].includes(el.tagName);
            if (isSection) score *= 1.15;

            const hasClasses = el.classList.length > 0;
            if (hasClasses && !['SECTION', 'ARTICLE', 'MAIN'].includes(el.tagName)) {
              score *= 1.05;
            }

            candidates.push({ el, score, elTop, elHeight: rect.height });
          }
        }

        if (candidates.length === 0) return null;

        candidates.sort((a, b) => b.score - a.score);

        let bestElement = candidates[0].el;
        let bestScore = candidates[0].score;

        // If best candidate is much larger than target, look for better children
        const bestRect = bestElement.getBoundingClientRect();
        if (bestRect.height > targetHeight * 2.5) {
          const children = bestElement.children;
          for (const child of children) {
            const childRect = child.getBoundingClientRect();
            const childTop = childRect.top + window.scrollY;
            const childBottom = childTop + childRect.height;
            const childOverlapStart = Math.max(yS, childTop);
            const childOverlapEnd = Math.min(yE, childBottom);
            const childOverlap = Math.max(0, childOverlapEnd - childOverlapStart);

            if (childOverlap > targetHeight * 0.5 && childRect.height < bestRect.height * 0.8) {
              const childRangeCoverage = childOverlap / targetHeight;
              const childElementCoverage = childOverlap / childRect.height;
              const childSizeRatio = childRect.height / targetHeight;
              const childSizePenalty = childSizeRatio > 2 ? Math.max(0.1, 1 / childSizeRatio) : 1;
              const childScore = (childRangeCoverage * 0.4 + childElementCoverage * 0.4) * childSizePenalty;

              if (childScore > bestScore * 0.7) {
                bestElement = child;
                bestScore = childScore;
                break;
              }
            }
          }
        }

        const rect = bestElement.getBoundingClientRect();
        const bbox = {
          x: 0,
          y: rect.top + window.scrollY,
          width: document.documentElement.scrollWidth,
          height: rect.height,
        };

        const html = bestElement.outerHTML;
        const images: { src: string; alt: string }[] = [];

        // Check <img> tags
        bestElement.querySelectorAll('img').forEach(img => {
          const src = img.src || img.dataset.src || '';
          if (src && !src.startsWith('data:')) {
            images.push({ src, alt: img.alt || '' });
          }
        });

        // CRITICAL: Check background-image on element itself
        const elStyle = window.getComputedStyle(bestElement);
        const elBgImage = elStyle.backgroundImage;
        if (elBgImage && elBgImage !== 'none' && elBgImage.includes('url(')) {
          const match = elBgImage.match(/url\(['"]?([^'"]+)['"]?\)/);
          if (match && match[1] && !match[1].startsWith('data:')) {
            images.push({ src: match[1], alt: 'background (self)' });
          }
        }

        // Also check child elements for background images
        bestElement.querySelectorAll('*').forEach(el => {
          const style = window.getComputedStyle(el);
          const bgImage = style.backgroundImage;
          if (bgImage && bgImage !== 'none' && bgImage.includes('url(')) {
            const match = bgImage.match(/url\(['"]?([^'"]+)['"]?\)/);
            if (match && match[1] && !match[1].startsWith('data:')) {
              images.push({ src: match[1], alt: 'background' });
            }
          }
        });

        return {
          html: html.substring(0, 10000),
          images,
          bbox,
          selector: bestElement.tagName.toLowerCase() +
            (bestElement.id ? `#${bestElement.id}` : '') +
            (bestElement.classList.length > 0 ? `.${Array.from(bestElement.classList).join('.')}` : ''),
          elementTop: rect.top + window.scrollY,
          elementHeight: rect.height,
          score: bestScore,
          candidateCount: candidates.length,
        };
      }, yStart, yEnd);

      // Take cropped screenshot
      let croppedScreenshot = '';
      if (sectionData) {
        try {
          const screenshotBuffer = await page.screenshot({
            clip: {
              x: 0,
              y: Math.max(0, sectionData.bbox.y),
              width: Math.min(dimensions.width, 1440),
              height: Math.min(sectionData.bbox.height, 2000),
            },
            type: 'png',
          }) as Buffer;
          croppedScreenshot = screenshotBuffer.toString('base64');
        } catch (e) {
          console.error('Screenshot failed:', e);
        }
      }

      // Return debug HTML page
      const html = `<!DOCTYPE html>
<html>
<head>
  <title>Debug Section: ${sectionName}</title>
  <style>
    body { font-family: system-ui; padding: 20px; max-width: 1400px; margin: 0 auto; }
    h1 { margin-bottom: 8px; }
    .section { background: #f5f5f5; padding: 16px; border-radius: 8px; margin: 16px 0; }
    .section h2 { margin-top: 0; }
    pre { background: #333; color: #0f0; padding: 12px; border-radius: 6px; overflow-x: auto; white-space: pre-wrap; font-size: 12px; max-height: 400px; overflow-y: auto; }
    img { max-width: 100%; border: 2px solid #333; }
    table { border-collapse: collapse; width: 100%; }
    td, th { border: 1px solid #ccc; padding: 8px; text-align: left; }
    .warning { background: #fff3cd; padding: 12px; border-radius: 6px; margin: 12px 0; }
    .success { background: #d4edda; padding: 12px; border-radius: 6px; margin: 12px 0; }
  </style>
</head>
<body>
  <h1>Debug Section Extraction</h1>
  <p><strong>URL:</strong> ${url}</p>
  <p><strong>Section:</strong> ${sectionName}</p>
  <p><strong>Y-Boundaries:</strong> ${yStart}px - ${yEnd}px (height: ${yEnd - yStart}px)</p>

  ${sectionData ? `
  <div class="success">
    <strong>Element Found:</strong> ${sectionData.selector}<br>
    <strong>Element Y:</strong> ${Math.round(sectionData.elementTop)}px - ${Math.round(sectionData.elementTop + sectionData.elementHeight)}px (height: ${Math.round(sectionData.elementHeight)}px)<br>
    <strong>Target Y:</strong> ${yStart}px - ${yEnd}px (height: ${yEnd - yStart}px)<br>
    <strong>Match Score:</strong> ${(sectionData.score * 100).toFixed(1)}%<br>
    <strong>Candidates Evaluated:</strong> ${sectionData.candidateCount || 'N/A'}
  </div>
  ` : `
  <div class="warning">
    <strong>No element found at Y position ${yStart}-${yEnd}</strong>
  </div>
  `}

  <div class="section">
    <h2>Cropped Screenshot Sent to Claude</h2>
    ${croppedScreenshot ? `<img src="data:image/png;base64,${croppedScreenshot}" />` : '<p>No screenshot captured</p>'}
  </div>

  <div class="section">
    <h2>Extracted Images (${sectionData?.images.length || 0})</h2>
    <table>
      <tr><th>Type</th><th>URL</th></tr>
      ${sectionData?.images.map(img => `<tr><td>${img.alt || 'img'}</td><td style="word-break: break-all; font-size: 11px;">${img.src}</td></tr>`).join('') || '<tr><td colspan="2">No images found</td></tr>'}
    </table>
  </div>

  <div class="section">
    <h2>Extracted HTML (first 10KB)</h2>
    <pre>${(sectionData?.html || 'No HTML extracted').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>
  </div>
</body>
</html>`;

      return new Response(html, {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    } finally {
      await browser.close();
    }
  } catch (error) {
    console.error('Debug section failed:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return Response.json(
      { success: false, error: message },
      { status: 500, headers: corsHeaders(env) }
    );
  }
}

/**
 * Batch generation UI for multiple blocks
 */
function handleBatchUI(env: Env): Response {
  const html = `<!DOCTYPE html>
<html>
<head>
  <title>Batch Block Generator</title>
  <style>
    body { font-family: system-ui; padding: 40px; max-width: 900px; margin: 0 auto; background: #f5f5f5; }
    h1 { margin-bottom: 8px; }
    .subtitle { color: #666; margin-bottom: 24px; }
    .url-input { margin-bottom: 16px; display: flex; gap: 12px; }
    .url-input input { flex: 1; padding: 12px; font-size: 16px; border: 1px solid #ccc; border-radius: 6px; }
    #analyzeBtn { padding: 12px 24px; font-size: 16px; background: #6c757d; color: white; border: none; border-radius: 6px; cursor: pointer; }
    #analyzeBtn:hover { background: #5a6268; }
    #analyzeBtn:disabled { background: #ccc; cursor: not-allowed; }
    .block-item { padding: 16px; margin: 8px 0; background: #fff; border-radius: 8px; display: flex; justify-content: space-between; align-items: center; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
    .block-item.loading { background: #fff3cd; }
    .block-item.success { background: #d4edda; }
    .block-item.error { background: #f8d7da; }
    .block-item.analyzing { background: #cce5ff; }
    .block-info { flex: 1; }
    .block-info strong { display: block; margin-bottom: 4px; }
    .selector { font-family: monospace; font-size: 12px; color: #666; }
    .description { font-size: 13px; color: #555; margin-top: 4px; }
    .badge { display: inline-block; padding: 2px 8px; font-size: 11px; border-radius: 4px; margin-left: 8px; }
    .badge.high { background: #dc3545; color: white; }
    .badge.medium { background: #ffc107; color: #333; }
    .badge.low { background: #6c757d; color: white; }
    .siblings { font-size: 12px; color: #28a745; font-weight: 500; margin-top: 2px; }
    .status { font-weight: 600; min-width: 100px; text-align: right; }
    button { padding: 8px 16px; cursor: pointer; }
    #startAll { font-size: 18px; padding: 14px 28px; background: #3b63fb; color: white; border: none; border-radius: 6px; margin-bottom: 24px; }
    #startAll:hover { background: #1d3ecf; }
    #startAll:disabled { background: #ccc; cursor: not-allowed; }
    .note { font-size: 13px; color: #888; margin-top: 20px; }
    .analyzing-msg { padding: 20px; text-align: center; color: #666; }
    #blocksContainer { margin-bottom: 24px; }
  </style>
</head>
<body>
  <h1>Batch Block Generator</h1>
  <p class="subtitle">Analyze any webpage to identify blocks, then generate them using Claude Vision</p>

  <div class="url-input">
    <input type="text" id="pageUrl" value="https://www.virginatlanticcargo.com/gb/en.html" placeholder="Page URL">
    <button id="analyzeBtn">Analyze Page</button>
  </div>

  <div id="blocksContainer">
    <div class="analyzing-msg">Enter a URL and click "Analyze Page" to identify content blocks</div>
  </div>

  <button id="startAll" style="display: none;">Generate All Blocks</button>
  <div id="blocks"></div>
  <p class="note" id="noteText" style="display: none;">All blocks run in parallel (Workers Paid: 30 concurrent browsers). ~20-40 seconds total.</p>

  <script>
    let identifiedBlocks = [];
    const blocksContainer = document.getElementById('blocksContainer');
    const blocksDiv = document.getElementById('blocks');
    const startAllBtn = document.getElementById('startAll');
    const noteText = document.getElementById('noteText');

    // Analyze page to identify blocks
    document.getElementById('analyzeBtn').onclick = async () => {
      const pageUrl = document.getElementById('pageUrl').value;
      const analyzeBtn = document.getElementById('analyzeBtn');

      analyzeBtn.disabled = true;
      analyzeBtn.textContent = 'Analyzing...';
      blocksContainer.innerHTML = '<div class="analyzing-msg">Analyzing page structure with Claude...</div>';
      startAllBtn.style.display = 'none';
      noteText.style.display = 'none';
      blocksDiv.innerHTML = '';

      try {
        const response = await fetch('/analyze', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: pageUrl })
        });

        const result = await response.json();

        if (!result.success) {
          throw new Error(result.error || 'Analysis failed');
        }

        identifiedBlocks = result.blocks || [];

        if (identifiedBlocks.length === 0) {
          blocksContainer.innerHTML = '<div class="analyzing-msg">No content blocks identified on this page</div>';
          return;
        }

        // Show identified blocks
        blocksContainer.innerHTML = '<h3>Identified Blocks (' + identifiedBlocks.length + ')</h3>';

        identifiedBlocks.forEach((block, i) => {
          const div = document.createElement('div');
          div.className = 'block-item';
          div.id = 'block-' + i;
          div.innerHTML = \`
            <div class="block-info">
              <strong>\${block.name} <span class="badge \${block.priority}">\${block.priority}</span> <span class="badge type">\${block.type}</span></strong>
              <div class="description">\${block.description}</div>
              <span class="selector" style="color: #17a2b8;">style: \${block.style}</span>
              <span class="selector" style="color: #666; margin-left: 12px;">Y: \${block.yStart}-\${block.yEnd}px</span>
            </div>
            <button class="debug-btn" data-index="\${i}" style="margin-right: 12px; padding: 4px 12px; font-size: 12px; background: #6c757d; color: white; border: none; border-radius: 4px; cursor: pointer;">Debug</button>
            <span class="status">Ready</span>
          \`;
          blocksContainer.appendChild(div);
        });

        // Add debug button handlers
        document.querySelectorAll('.debug-btn').forEach(btn => {
          btn.onclick = async (e) => {
            e.stopPropagation();
            const idx = parseInt(btn.dataset.index);
            const block = identifiedBlocks[idx];
            const pageUrl = document.getElementById('pageUrl').value;

            btn.textContent = 'Loading...';
            btn.disabled = true;

            try {
              const response = await fetch('/debug/section', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  url: pageUrl,
                  sectionName: block.name,
                  sectionDescription: block.description,
                  yStart: block.yStart,
                  yEnd: block.yEnd
                })
              });

              const html = await response.text();
              const newWindow = window.open('', '_blank');
              if (newWindow) {
                newWindow.document.write(html);
                newWindow.document.close();
              }
            } catch (err) {
              alert('Debug failed: ' + err.message);
            } finally {
              btn.textContent = 'Debug';
              btn.disabled = false;
            }
          };
        });

        startAllBtn.style.display = 'block';
        noteText.style.display = 'block';

      } catch (err) {
        blocksContainer.innerHTML = '<div class="block-item error"><div>' + err.message + '</div></div>';
      } finally {
        analyzeBtn.disabled = false;
        analyzeBtn.textContent = 'Analyze Page';
      }
    };

    // Concurrency limiter
    async function runWithConcurrency(tasks, limit) {
      const results = [];
      const executing = [];

      for (const task of tasks) {
        const p = task().then(r => {
          executing.splice(executing.indexOf(p), 1);
          return r;
        });
        results.push(p);
        executing.push(p);

        if (executing.length >= limit) {
          await Promise.race(executing);
        }
      }

      return Promise.all(results);
    }

    // Generate all identified blocks
    startAllBtn.onclick = async () => {
      const pageUrl = document.getElementById('pageUrl').value;
      startAllBtn.disabled = true;

      // Create task functions for each block
      const tasks = identifiedBlocks.map((block, i) => async () => {
        const div = document.getElementById('block-' + i);
        div.className = 'block-item loading';
        div.querySelector('.status').textContent = 'Generating...';

        try {
          const requestBody = {
            url: pageUrl,
            sectionDescription: block.description,
            sectionName: block.name,
            yStart: block.yStart,
            yEnd: block.yEnd
          };
          const response = await fetch('/preview', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody)
          });

          if (!response.ok) {
            const err = await response.json().catch(() => ({ error: 'Unknown error' }));
            throw new Error(err.error || 'Generation failed');
          }

          const html = await response.text();
          div.className = 'block-item success';
          div.querySelector('.status').textContent = 'Opening...';

          const newWindow = window.open('', '_blank');
          if (newWindow) {
            newWindow.document.write(html);
            newWindow.document.close();
            div.querySelector('.status').textContent = 'Done!';
          } else {
            div.querySelector('.status').textContent = 'Done (popup blocked)';
          }
        } catch (err) {
          div.className = 'block-item error';
          div.querySelector('.status').textContent = err.message;
        }
      });

      // Run with max 10 concurrent browser sessions
      await runWithConcurrency(tasks, 10);
      startAllBtn.disabled = false;
    };
  </script>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

/**
 * Parses and validates the request body
 * Supports both boundingBox (new) and selector (legacy)
 */
async function parseRequestBody(request: Request): Promise<BlockRequest> {
  const contentType = request.headers.get('content-type') || '';

  if (!contentType.includes('application/json')) {
    throw new BlockGeneratorError(
      'Content-Type must be application/json',
      'INVALID_REQUEST'
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new BlockGeneratorError(
      'Invalid JSON in request body',
      'INVALID_REQUEST'
    );
  }

  if (!body || typeof body !== 'object') {
    throw new BlockGeneratorError(
      'Request body must be an object',
      'INVALID_REQUEST'
    );
  }

  const { url, selector, boundingBox, siblingSelectors, sectionDescription, sectionName, yStart, yEnd } = body as Record<string, unknown>;

  if (typeof url !== 'string' || !url.trim()) {
    throw new BlockGeneratorError(
      'Missing or invalid "url" field',
      'INVALID_REQUEST'
    );
  }

  // Parse description-based approach (from /analyze)
  let parsedSectionDescription: string | undefined;
  let parsedSectionName: string | undefined;
  if (typeof sectionDescription === 'string' && sectionDescription.trim() &&
      typeof sectionName === 'string' && sectionName.trim()) {
    parsedSectionDescription = sectionDescription.trim();
    parsedSectionName = sectionName.trim();
  }

  // Parse bounding box if provided (new approach)
  let parsedBbox: { x: number; y: number; width: number; height: number } | undefined;
  if (boundingBox && typeof boundingBox === 'object') {
    const bbox = boundingBox as Record<string, unknown>;
    if (typeof bbox.x === 'number' && typeof bbox.y === 'number' &&
        typeof bbox.width === 'number' && typeof bbox.height === 'number') {
      parsedBbox = {
        x: bbox.x,
        y: bbox.y,
        width: bbox.width,
        height: bbox.height,
      };
    }
  }

  // Parse selector if provided (legacy approach)
  let parsedSelector: string | undefined;
  if (typeof selector === 'string' && selector.trim()) {
    parsedSelector = selector.trim();
  }

  // Require either sectionDescription+sectionName, boundingBox, or selector
  if (!parsedSectionDescription && !parsedBbox && !parsedSelector) {
    throw new BlockGeneratorError(
      'Either "sectionDescription"+"sectionName", "boundingBox", or "selector" is required',
      'INVALID_REQUEST'
    );
  }

  // Parse sibling selectors if provided (legacy)
  let parsedSiblings: string[] | undefined;
  if (Array.isArray(siblingSelectors)) {
    parsedSiblings = siblingSelectors.filter(s => typeof s === 'string' && s.trim()).map(s => (s as string).trim());
    if (parsedSiblings.length === 0) parsedSiblings = undefined;
  }

  // Parse Y-boundaries if provided
  const parsedYStart = typeof yStart === 'number' ? yStart : undefined;
  const parsedYEnd = typeof yEnd === 'number' ? yEnd : undefined;

  return {
    url: url.trim(),
    selector: parsedSelector,
    boundingBox: parsedBbox,
    siblingSelectors: parsedSiblings,
    sectionDescription: parsedSectionDescription,
    sectionName: parsedSectionName,
    yStart: parsedYStart,
    yEnd: parsedYEnd,
  };
}

/**
 * Generate a readable branch name from a website URL
 * e.g., "https://www.researchaffiliates.com/path" -> "researchaffiliates"
 * e.g., "https://www.wknd-trendsetters.site/" -> "wknd-trendsetters"
 * Note: EDS does not support subbranches (e.g., "site/name"), so we use flat branch names
 */
function generateBranchNameFromUrl(siteUrl: string): string {
  try {
    // Parse the URL (add protocol if missing)
    const urlStr = siteUrl.startsWith('http') ? siteUrl : `https://${siteUrl}`;
    const url = new URL(urlStr);

    // Get hostname and remove www. prefix
    let hostname = url.hostname.toLowerCase();
    if (hostname.startsWith('www.')) {
      hostname = hostname.slice(4);
    }

    // Remove TLD (.com, .site, .org, etc.) and keep the main domain name
    const parts = hostname.split('.');
    let siteName: string;

    if (parts.length >= 2) {
      // Take everything except the last part (TLD)
      // For "researchaffiliates.com" -> "researchaffiliates"
      // For "sub.domain.co.uk" -> "sub-domain-co"
      siteName = parts.slice(0, -1).join('-');
    } else {
      siteName = hostname;
    }

    // Sanitize: only alphanumeric and hyphens, no double hyphens
    siteName = siteName.replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');

    return siteName;
  } catch {
    // If URL parsing fails, create a safe branch name from the input
    const safeName = siteUrl.toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '')
      .replace(/[^a-z0-9]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 50);
    return safeName || 'unknown';
  }
}

// =============================================================================
// EDS Preview Flow Helper Functions
// =============================================================================

/**
 * Generate a random 6-character session ID
 */
function generateSessionId(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < 6; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

/**
 * Build variant branch name: {session}-{opt}-{iter}
 * Short format to stay under 63-char subdomain limit for EDS preview URLs
 */
function buildVariantBranchName(
  sessionId: string,
  option: number,
  iteration: number
): string {
  return `${sessionId}-${option}-${iteration}`;
}

/**
 * Build variant DA path: {basePath}/{session}-{opt}-{iter}
 */
function buildVariantDaPath(
  basePath: string,
  sessionId: string,
  option: number,
  iteration: number
): string {
  // Ensure basePath starts with / and doesn't end with /
  const normalizedBase = basePath.startsWith('/') ? basePath : `/${basePath}`;
  const cleanBase = normalizedBase.endsWith('/') ? normalizedBase.slice(0, -1) : normalizedBase;
  return `${cleanBase}/${sessionId}-${option}-${iteration}`;
}

/**
 * Build variant preview URL
 */
function buildVariantPreviewUrl(
  owner: string,
  repo: string,
  branch: string,
  daPath: string
): string {
  return `https://${branch}--${repo}--${owner}.aem.page${daPath}`;
}

/**
 * Handles the /block-github endpoint
 * Pushes generated block code (JS, CSS) to a user's GitHub repository in a single commit
 */
async function handleBlockGitHub(request: Request, env: Env): Promise<Response> {
  try {
    const body = await request.json() as GitHubPushRequest;

    // Validate required fields
    const missing: string[] = [];
    if (!body.owner) missing.push('owner');
    if (!body.repo) missing.push('repo');
    if (!body.blockName) missing.push('blockName');
    if (!body.js) missing.push('js');
    if (!body.css) missing.push('css');
    if (!body.token) missing.push('token');

    if (missing.length > 0) {
      throw new BlockGeneratorError(
        `Missing required fields: ${missing.join(', ')}`,
        'INVALID_REQUEST',
        400
      );
    }

    // Sanitize block name (lowercase, alphanumeric + hyphens)
    const blockName = body.blockName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');

    // Determine branch: use siteUrl to generate, or explicit branch, or default to main
    let branch: string;
    if (body.siteUrl) {
      branch = generateBranchNameFromUrl(body.siteUrl);
    } else {
      branch = body.branch || 'main';
    }

    // Define file paths
    const jsPath = `blocks/${blockName}/${blockName}.js`;
    const cssPath = `blocks/${blockName}/${blockName}.css`;

    // GitHub API headers
    const githubHeaders: Record<string, string> = {
      'Accept': 'application/vnd.github+json',
      'Authorization': `Bearer ${body.token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'AEM-Block-Generator-Worker',
    };

    // Helper for GitHub API calls
    async function githubFetch(url: string, options?: RequestInit): Promise<Response> {
      const response = await fetch(url, {
        ...options,
        headers: { ...githubHeaders, ...options?.headers },
      });

      if (response.status === 401 || response.status === 403) {
        throw new BlockGeneratorError(
          'GitHub authentication failed. Check your token permissions.',
          'GITHUB_AUTH_FAILED',
          401
        );
      }

      return response;
    }

    // Step 1: Get the current commit SHA for the branch (create branch if needed)
    let currentCommitSha: string;

    const refResponse = await githubFetch(
      `https://api.github.com/repos/${body.owner}/${body.repo}/git/ref/heads/${branch}`
    );

    if (refResponse.status === 404 && branch !== 'main') {
      // Branch doesn't exist, create it from main
      console.log(`Branch ${branch} not found, creating from main...`);

      // Get main branch SHA
      const mainRefResponse = await githubFetch(
        `https://api.github.com/repos/${body.owner}/${body.repo}/git/ref/heads/main`
      );

      if (!mainRefResponse.ok) {
        const error = await mainRefResponse.text();
        throw new BlockGeneratorError(
          `Failed to get main branch: ${mainRefResponse.status} - ${error}`,
          'GITHUB_API_ERROR',
          mainRefResponse.status
        );
      }

      const mainRefData = await mainRefResponse.json() as { object: { sha: string } };
      const mainSha = mainRefData.object.sha;

      // Create new branch from main
      const createBranchResponse = await githubFetch(
        `https://api.github.com/repos/${body.owner}/${body.repo}/git/refs`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ref: `refs/heads/${branch}`,
            sha: mainSha,
          }),
        }
      );

      if (!createBranchResponse.ok) {
        const error = await createBranchResponse.text();
        throw new BlockGeneratorError(
          `Failed to create branch ${branch}: ${createBranchResponse.status} - ${error}`,
          'GITHUB_API_ERROR',
          createBranchResponse.status
        );
      }

      console.log(`Created branch ${branch} from main`);
      currentCommitSha = mainSha;
    } else if (!refResponse.ok) {
      const error = await refResponse.text();
      throw new BlockGeneratorError(
        `Failed to get branch ref: ${refResponse.status} - ${error}`,
        'GITHUB_API_ERROR',
        refResponse.status
      );
    } else {
      const refData = await refResponse.json() as { object: { sha: string } };
      currentCommitSha = refData.object.sha;
    }

    // Step 2: Get the tree SHA from the current commit
    const commitResponse = await githubFetch(
      `https://api.github.com/repos/${body.owner}/${body.repo}/git/commits/${currentCommitSha}`
    );

    if (!commitResponse.ok) {
      const error = await commitResponse.text();
      throw new BlockGeneratorError(
        `Failed to get commit: ${commitResponse.status} - ${error}`,
        'GITHUB_API_ERROR',
        commitResponse.status
      );
    }

    const commitData = await commitResponse.json() as { tree: { sha: string } };
    const baseTreeSha = commitData.tree.sha;

    // Step 3: Create blobs for both files
    const createBlob = async (content: string): Promise<string> => {
      const blobResponse = await githubFetch(
        `https://api.github.com/repos/${body.owner}/${body.repo}/git/blobs`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            content: content,
            encoding: 'utf-8',
          }),
        }
      );

      if (!blobResponse.ok) {
        const error = await blobResponse.text();
        throw new BlockGeneratorError(
          `Failed to create blob: ${blobResponse.status} - ${error}`,
          'GITHUB_API_ERROR',
          blobResponse.status
        );
      }

      const blobData = await blobResponse.json() as { sha: string };
      return blobData.sha;
    };

    const [jsBlobSha, cssBlobSha] = await Promise.all([
      createBlob(body.js),
      createBlob(body.css),
    ]);

    // Step 4: Create a new tree with both files
    const treeResponse = await githubFetch(
      `https://api.github.com/repos/${body.owner}/${body.repo}/git/trees`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          base_tree: baseTreeSha,
          tree: [
            {
              path: jsPath,
              mode: '100644',
              type: 'blob',
              sha: jsBlobSha,
            },
            {
              path: cssPath,
              mode: '100644',
              type: 'blob',
              sha: cssBlobSha,
            },
          ],
        }),
      }
    );

    if (!treeResponse.ok) {
      const error = await treeResponse.text();
      throw new BlockGeneratorError(
        `Failed to create tree: ${treeResponse.status} - ${error}`,
        'GITHUB_API_ERROR',
        treeResponse.status
      );
    }

    const treeData = await treeResponse.json() as { sha: string };
    const newTreeSha = treeData.sha;

    // Step 5: Create a new commit
    const newCommitResponse = await githubFetch(
      `https://api.github.com/repos/${body.owner}/${body.repo}/git/commits`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: body.commitMessage || `Add/update ${blockName} block`,
          tree: newTreeSha,
          parents: [currentCommitSha],
        }),
      }
    );

    if (!newCommitResponse.ok) {
      const error = await newCommitResponse.text();
      throw new BlockGeneratorError(
        `Failed to create commit: ${newCommitResponse.status} - ${error}`,
        'GITHUB_API_ERROR',
        newCommitResponse.status
      );
    }

    const newCommitData = await newCommitResponse.json() as { sha: string };
    const newCommitSha = newCommitData.sha;

    // Step 6: Update the branch reference to point to the new commit
    const updateRefResponse = await githubFetch(
      `https://api.github.com/repos/${body.owner}/${body.repo}/git/refs/heads/${branch}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sha: newCommitSha,
        }),
      }
    );

    if (!updateRefResponse.ok) {
      const error = await updateRefResponse.text();
      throw new BlockGeneratorError(
        `Failed to update branch ref: ${updateRefResponse.status} - ${error}`,
        'GITHUB_API_ERROR',
        updateRefResponse.status
      );
    }

    const response: GitHubPushResponse = {
      success: true,
      commitUrl: `https://github.com/${body.owner}/${body.repo}/commit/${newCommitSha}`,
      jsPath: jsPath,
      cssPath: cssPath,
      commitSha: newCommitSha,
      branch: branch,
    };

    return Response.json(response, { status: 200, headers: corsHeaders(env) });
  } catch (error) {
    return handleError(error, env);
  }
}

/**
 * Exchange Adobe IMS credentials for an access token
 */
async function exchangeDACredentialsForToken(
  clientId: string,
  clientSecret: string,
  serviceToken: string
): Promise<string> {
  const IMS_TOKEN_ENDPOINT = 'https://ims-na1.adobelogin.com/ims/token/v3';

  const formParams = new URLSearchParams();
  formParams.append('grant_type', 'authorization_code');
  formParams.append('client_id', clientId);
  formParams.append('client_secret', clientSecret);
  formParams.append('code', serviceToken);

  const response = await fetch(IMS_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: formParams.toString(),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new BlockGeneratorError(
      `IMS token exchange failed: ${response.status} - ${errorText}`,
      'DA_AUTH_FAILED',
      401
    );
  }

  const tokenData = await response.json() as { access_token?: string };

  if (!tokenData.access_token) {
    throw new BlockGeneratorError(
      'No access token received from IMS',
      'DA_AUTH_FAILED',
      401
    );
  }

  return tokenData.access_token;
}

/**
 * Wrap block HTML in proper EDS page structure for DA
 * This creates a full page with header, main, and footer sections
 */
function wrapBlockInPageStructure(blockHtml: string): string {
  // Check if the HTML already has proper page structure
  if (blockHtml.includes('<body') || blockHtml.includes('<main')) {
    return blockHtml;
  }

  return `<body>
  <header></header>
  <main>
    <div>
${blockHtml.split('\n').map(line => '      ' + line).join('\n')}
    </div>
  </main>
  <footer></footer>
</body>`;
}

/**
 * Handles the /block-da endpoint
 * Creates a new page in Adobe DA Admin (da.live) with block table HTML
 */
async function handleBlockDA(request: Request, env: Env): Promise<Response> {
  try {
    const body = await request.json() as DACreatePageRequest;

    // Validate required fields (token is optional - can use service account)
    const missing: string[] = [];
    if (!body.org) missing.push('org');
    if (!body.site) missing.push('site');
    if (!body.path) missing.push('path');
    if (!body.html) missing.push('html');

    if (missing.length > 0) {
      throw new BlockGeneratorError(
        `Missing required fields: ${missing.join(', ')}`,
        'INVALID_REQUEST',
        400
      );
    }

    // Get token: use provided token or exchange service account credentials
    let token = body.token;
    if (!token) {
      // Check for service account credentials in env
      if (env.DA_CLIENT_ID && env.DA_CLIENT_SECRET && env.DA_SERVICE_TOKEN) {
        console.log('No token provided, using service account credentials');
        token = await exchangeDACredentialsForToken(
          env.DA_CLIENT_ID,
          env.DA_CLIENT_SECRET,
          env.DA_SERVICE_TOKEN
        );
      } else {
        throw new BlockGeneratorError(
          'No token provided and service account not configured. Provide token or set DA_CLIENT_ID, DA_CLIENT_SECRET, DA_SERVICE_TOKEN.',
          'DA_AUTH_FAILED',
          401
        );
      }
    }

    // Normalize path (ensure it starts with / and ends with .html)
    let path = body.path.startsWith('/') ? body.path : `/${body.path}`;
    if (!path.endsWith('.html')) {
      path = `${path}.html`;
    }

    // DA Admin API endpoint
    const daUrl = `https://admin.da.live/source/${body.org}/${body.site}${path}`;

    // Wrap block HTML in proper page structure
    const wrappedHtml = wrapBlockInPageStructure(body.html);

    // Create FormData with HTML content
    const formData = new FormData();
    const blob = new Blob([wrappedHtml], { type: 'text/html' });
    formData.append('data', blob);

    // Make request to DA Admin API
    const response = await fetch(daUrl, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${token}`,
      },
      body: formData,
    });

    if (response.status === 401 || response.status === 403) {
      throw new BlockGeneratorError(
        'DA Admin authentication failed. Check your token.',
        'DA_AUTH_FAILED',
        401
      );
    }

    if (!response.ok) {
      const error = await response.text();
      throw new BlockGeneratorError(
        `DA Admin API error: ${response.status} - ${error}`,
        'DA_API_ERROR',
        response.status
      );
    }

    // Construct URLs
    const pageUrl = `https://da.live/edit#/${body.org}/${body.site}${path.replace('.html', '')}`;
    const previewUrl = `https://main--${body.site}--${body.org}.aem.page${path.replace('.html', '')}`;

    const result: DACreatePageResponse = {
      success: true,
      pageUrl: pageUrl,
      previewUrl: previewUrl,
      path: `/${body.org}/${body.site}${path}`,
    };

    return Response.json(result, { status: 201, headers: corsHeaders(env) });
  } catch (error) {
    return handleError(error, env);
  }
}

// =============================================================================
// EDS Preview Flow Handlers
// =============================================================================

/**
 * Helper to make GitHub API calls with proper headers and error handling
 */
function createGitHubFetcher(token: string) {
  const headers: Record<string, string> = {
    'Accept': 'application/vnd.github+json',
    'Authorization': `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'AEM-Block-Generator-Worker',
  };

  return async function githubFetch(url: string, options?: RequestInit): Promise<Response> {
    const response = await fetch(url, {
      ...options,
      headers: { ...headers, ...options?.headers },
    });

    if (response.status === 401 || response.status === 403) {
      throw new BlockGeneratorError(
        'GitHub authentication failed. Check your token permissions.',
        'GITHUB_AUTH_FAILED',
        401
      );
    }

    return response;
  };
}

/**
 * Ensure a branch exists, creating from source if it doesn't
 * Returns the current commit SHA of the branch
 */
async function ensureBranchExists(
  githubFetch: (url: string, options?: RequestInit) => Promise<Response>,
  owner: string,
  repo: string,
  branch: string,
  sourceBranch: string = 'main'
): Promise<string> {
  const refResponse = await githubFetch(
    `https://api.github.com/repos/${owner}/${repo}/git/ref/heads/${branch}`
  );

  if (refResponse.status === 404) {
    console.log(`Branch ${branch} not found, creating from ${sourceBranch}...`);

    // Get source branch SHA
    const sourceRefResponse = await githubFetch(
      `https://api.github.com/repos/${owner}/${repo}/git/ref/heads/${sourceBranch}`
    );

    if (!sourceRefResponse.ok) {
      const error = await sourceRefResponse.text();
      throw new BlockGeneratorError(
        `Failed to get ${sourceBranch} branch: ${sourceRefResponse.status} - ${error}`,
        'GITHUB_API_ERROR',
        sourceRefResponse.status
      );
    }

    const sourceRefData = await sourceRefResponse.json() as { object: { sha: string } };
    const sourceSha = sourceRefData.object.sha;

    // Create new branch
    const createBranchResponse = await githubFetch(
      `https://api.github.com/repos/${owner}/${repo}/git/refs`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ref: `refs/heads/${branch}`,
          sha: sourceSha,
        }),
      }
    );

    if (!createBranchResponse.ok) {
      const error = await createBranchResponse.text();
      throw new BlockGeneratorError(
        `Failed to create branch ${branch}: ${createBranchResponse.status} - ${error}`,
        'GITHUB_API_ERROR',
        createBranchResponse.status
      );
    }

    console.log(`Created branch ${branch} from ${sourceBranch}`);
    return sourceSha;
  }

  if (!refResponse.ok) {
    const error = await refResponse.text();
    throw new BlockGeneratorError(
      `Failed to get branch ref: ${refResponse.status} - ${error}`,
      'GITHUB_API_ERROR',
      refResponse.status
    );
  }

  const refData = await refResponse.json() as { object: { sha: string } };
  return refData.object.sha;
}

/**
 * Get file contents from a specific branch
 * Returns null if file doesn't exist
 */
async function getFileFromBranch(
  githubFetch: (url: string, options?: RequestInit) => Promise<Response>,
  owner: string,
  repo: string,
  branch: string,
  path: string
): Promise<string | null> {
  const response = await githubFetch(
    `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${branch}`
  );

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    const error = await response.text();
    throw new BlockGeneratorError(
      `Failed to get file ${path} from branch ${branch}: ${response.status} - ${error}`,
      'GITHUB_API_ERROR',
      response.status
    );
  }

  const data = await response.json() as { content: string; encoding: string };
  if (data.encoding !== 'base64') {
    throw new BlockGeneratorError(
      `Unexpected encoding for file ${path}: ${data.encoding}`,
      'GITHUB_API_ERROR'
    );
  }

  return atob(data.content);
}

/**
 * Push files to a branch in a single commit
 */
async function pushFilesToBranch(
  githubFetch: (url: string, options?: RequestInit) => Promise<Response>,
  owner: string,
  repo: string,
  branch: string,
  files: Array<{ path: string; content: string }>,
  commitMessage: string
): Promise<{ commitSha: string; commitUrl: string }> {
  // Get current commit SHA
  const currentCommitSha = await ensureBranchExists(githubFetch, owner, repo, branch, branch.split('-')[0]);

  // Get base tree SHA
  const commitResponse = await githubFetch(
    `https://api.github.com/repos/${owner}/${repo}/git/commits/${currentCommitSha}`
  );

  if (!commitResponse.ok) {
    const error = await commitResponse.text();
    throw new BlockGeneratorError(
      `Failed to get commit: ${commitResponse.status} - ${error}`,
      'GITHUB_API_ERROR',
      commitResponse.status
    );
  }

  const commitData = await commitResponse.json() as { tree: { sha: string } };
  const baseTreeSha = commitData.tree.sha;

  // Create blobs for all files
  const createBlob = async (content: string): Promise<string> => {
    const blobResponse = await githubFetch(
      `https://api.github.com/repos/${owner}/${repo}/git/blobs`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, encoding: 'utf-8' }),
      }
    );

    if (!blobResponse.ok) {
      const error = await blobResponse.text();
      throw new BlockGeneratorError(
        `Failed to create blob: ${blobResponse.status} - ${error}`,
        'GITHUB_API_ERROR',
        blobResponse.status
      );
    }

    const blobData = await blobResponse.json() as { sha: string };
    return blobData.sha;
  };

  const blobShas = await Promise.all(files.map(f => createBlob(f.content)));

  // Create new tree
  const treeResponse = await githubFetch(
    `https://api.github.com/repos/${owner}/${repo}/git/trees`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        base_tree: baseTreeSha,
        tree: files.map((f, i) => ({
          path: f.path,
          mode: '100644',
          type: 'blob',
          sha: blobShas[i],
        })),
      }),
    }
  );

  if (!treeResponse.ok) {
    const error = await treeResponse.text();
    throw new BlockGeneratorError(
      `Failed to create tree: ${treeResponse.status} - ${error}`,
      'GITHUB_API_ERROR',
      treeResponse.status
    );
  }

  const treeData = await treeResponse.json() as { sha: string };

  // Create commit
  const newCommitResponse = await githubFetch(
    `https://api.github.com/repos/${owner}/${repo}/git/commits`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: commitMessage,
        tree: treeData.sha,
        parents: [currentCommitSha],
      }),
    }
  );

  if (!newCommitResponse.ok) {
    const error = await newCommitResponse.text();
    throw new BlockGeneratorError(
      `Failed to create commit: ${newCommitResponse.status} - ${error}`,
      'GITHUB_API_ERROR',
      newCommitResponse.status
    );
  }

  const newCommitData = await newCommitResponse.json() as { sha: string };

  // Update branch ref
  const updateRefResponse = await githubFetch(
    `https://api.github.com/repos/${owner}/${repo}/git/refs/heads/${branch}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sha: newCommitData.sha }),
    }
  );

  if (!updateRefResponse.ok) {
    const error = await updateRefResponse.text();
    throw new BlockGeneratorError(
      `Failed to update branch ref: ${updateRefResponse.status} - ${error}`,
      'GITHUB_API_ERROR',
      updateRefResponse.status
    );
  }

  return {
    commitSha: newCommitData.sha,
    commitUrl: `https://github.com/${owner}/${repo}/commit/${newCommitData.sha}`,
  };
}

/**
 * Handles /block-variant-push endpoint
 * Pushes a block variant to GitHub (code) and DA (content)
 */
async function handleBlockVariantPush(request: Request, env: Env): Promise<Response> {
  try {
    const body = await request.json() as BlockVariantPushRequest;

    // Validate required fields
    const missing: string[] = [];
    if (!body.sessionId) missing.push('sessionId');
    if (!body.blockName) missing.push('blockName');
    if (body.option === undefined) missing.push('option');
    if (body.iteration === undefined) missing.push('iteration');
    if (!body.html) missing.push('html');
    if (!body.css) missing.push('css');
    if (!body.js) missing.push('js');
    if (!body.github?.owner) missing.push('github.owner');
    if (!body.github?.repo) missing.push('github.repo');
    if (!body.da?.org) missing.push('da.org');
    if (!body.da?.site) missing.push('da.site');

    // GitHub token: use request token or fall back to env
    const githubToken = body.github?.token || env.GITHUB_TOKEN;
    if (!githubToken) missing.push('github.token (or GITHUB_TOKEN env)');

    if (missing.length > 0) {
      throw new BlockGeneratorError(
        `Missing required fields: ${missing.join(', ')}`,
        'INVALID_REQUEST',
        400
      );
    }

    // Sanitize block name
    const blockName = body.blockName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');

    // Build variant identifiers (short format to stay under 63-char subdomain limit)
    const daBasePath = body.da.basePath || '/drafts/gen';
    const variantBranch = buildVariantBranchName(body.sessionId, body.option, body.iteration);
    const variantDaPath = buildVariantDaPath(daBasePath, body.sessionId, body.option, body.iteration);
    const previewUrl = buildVariantPreviewUrl(body.github.owner, body.github.repo, variantBranch, variantDaPath);

    console.log(`Pushing variant: branch=${variantBranch}, daPath=${variantDaPath}`);

    // Create GitHub fetcher
    const githubFetch = createGitHubFetcher(githubToken);

    // Create variant branch from main and push code
    await ensureBranchExists(githubFetch, body.github.owner, body.github.repo, variantBranch, 'main');

    const jsPath = `blocks/${blockName}/${blockName}.js`;
    const cssPath = `blocks/${blockName}/${blockName}.css`;

    const { commitSha, commitUrl } = await pushFilesToBranch(
      githubFetch,
      body.github.owner,
      body.github.repo,
      variantBranch,
      [
        { path: jsPath, content: body.js },
        { path: cssPath, content: body.css },
      ],
      `Add ${blockName} block (session ${body.sessionId}, opt ${body.option}, iter ${body.iteration})`
    );

    console.log(`Pushed code to GitHub: ${commitUrl}`);

    // Step 3: Push HTML to DA
    const wrappedHtml = wrapBlockInPageStructure(body.html);

    // Get DA token
    let daToken = body.da.token;
    if (!daToken && env.DA_CLIENT_ID && env.DA_CLIENT_SECRET && env.DA_SERVICE_TOKEN) {
      daToken = await exchangeDACredentialsForToken(
        env.DA_CLIENT_ID,
        env.DA_CLIENT_SECRET,
        env.DA_SERVICE_TOKEN
      );
    }

    if (!daToken) {
      throw new BlockGeneratorError(
        'No DA token provided and service account not configured',
        'DA_AUTH_FAILED',
        401
      );
    }

    const daPath = `${variantDaPath}.html`;
    const daUrl = `https://admin.da.live/source/${body.da.org}/${body.da.site}${daPath}`;

    const formData = new FormData();
    const blob = new Blob([wrappedHtml], { type: 'text/html' });
    formData.append('data', blob);

    const daResponse = await fetch(daUrl, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${daToken}` },
      body: formData,
    });

    if (!daResponse.ok) {
      const error = await daResponse.text();
      throw new BlockGeneratorError(
        `DA Admin API error: ${daResponse.status} - ${error}`,
        'DA_API_ERROR',
        daResponse.status
      );
    }

    console.log(`Pushed content to DA: ${variantDaPath}`);

    // Trigger AEM Admin preview API to make content available at preview URL
    // Uses IMS service account token for authentication
    const aemPreviewUrl = `https://admin.hlx.page/preview/${body.github.owner}/${body.github.repo}/${variantBranch}${variantDaPath}`;
    console.log(`Triggering AEM preview: ${aemPreviewUrl}`);

    try {
      const imsToken = await getDAToken(env);
      let aemResponse = await fetch(aemPreviewUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${imsToken}`,
        },
      });

      // Handle token expiration - retry once with fresh token
      if (aemResponse.status === 401) {
        console.log('AEM preview 401, clearing cached token and retrying...');
        clearCachedToken();
        const freshToken = await getDAToken(env);
        aemResponse = await fetch(aemPreviewUrl, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${freshToken}`,
          },
        });
      }

      if (aemResponse.ok) {
        console.log(`AEM preview triggered successfully`);
      } else {
        const aemError = await aemResponse.text();
        console.warn(`AEM preview trigger failed (${aemResponse.status}): ${aemError}`);
        // Don't fail the whole request - preview might still work after a delay
      }
    } catch (aemErr) {
      console.warn('AEM preview trigger error:', aemErr);
      // Don't fail - preview API is best-effort
    }

    // Build response
    const variant: BlockVariant = {
      option: body.option,
      iteration: body.iteration,
      blockName,
      branch: variantBranch,
      daPath: variantDaPath,
      previewUrl,
      html: body.html,
      css: body.css,
      js: body.js,
    };

    const response: BlockVariantPushResponse = {
      success: true,
      variant,
    };

    return Response.json(response, { status: 201, headers: corsHeaders(env) });
  } catch (error) {
    return handleError(error, env);
  }
}

/**
 * Handles /block-finalize endpoint
 * Merges winning variant to site branch and cleans up
 */
async function handleBlockFinalize(request: Request, env: Env): Promise<Response> {
  try {
    const body = await request.json() as BlockFinalizeRequest;

    // Validate required fields
    const missing: string[] = [];
    if (!body.sessionId) missing.push('sessionId');
    if (!body.blockName) missing.push('blockName');
    if (!body.winner?.option) missing.push('winner.option');
    if (!body.winner?.iteration) missing.push('winner.iteration');
    if (!body.github?.owner) missing.push('github.owner');
    if (!body.github?.repo) missing.push('github.repo');

    // GitHub token: use request token or fall back to env
    const githubToken = body.github?.token || env.GITHUB_TOKEN;
    if (!githubToken) missing.push('github.token (or GITHUB_TOKEN env)');

    if (missing.length > 0) {
      throw new BlockGeneratorError(
        `Missing required fields: ${missing.join(', ')}`,
        'INVALID_REQUEST',
        400
      );
    }

    const blockName = body.blockName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
    const githubFetch = createGitHubFetcher(githubToken);

    // Build winner branch name (short format)
    const winnerBranch = buildVariantBranchName(
      body.sessionId,
      body.winner.option,
      body.winner.iteration
    );

    console.log(`Finalizing: merging ${winnerBranch} into main`);

    // Create merge into main (using GitHub merge API)
    const mergeResponse = await githubFetch(
      `https://api.github.com/repos/${body.github.owner}/${body.github.repo}/merges`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          base: 'main',
          head: winnerBranch,
          commit_message: `Merge ${blockName} block from generation session ${body.sessionId}`,
        }),
      }
    );

    if (!mergeResponse.ok) {
      const error = await mergeResponse.text();
      throw new BlockGeneratorError(
        `Failed to merge: ${mergeResponse.status} - ${error}`,
        'GITHUB_API_ERROR',
        mergeResponse.status
      );
    }

    const mergeData = await mergeResponse.json() as { sha: string };

    const commitUrl = `https://github.com/${body.github.owner}/${body.github.repo}/commit/${mergeData.sha}`;

    const result: BlockFinalizeResponse = {
      success: true,
      merged: {
        branch: winnerBranch,
        into: 'main',
        commitSha: mergeData.sha,
        commitUrl,
      },
    };

    // Copy winner DA page to library path
    if (body.da) {
      try {
        const imsToken = await getDAToken(env);
        const winnerDaPath = `/drafts/gen/${body.sessionId}-${body.winner.option}-${body.winner.iteration}`;
        const libraryPath = `/docs/library/blocks/${blockName}`;

        console.log(`Copying DA page from ${winnerDaPath} to ${libraryPath}`);

        // First, get the source page content
        const sourceUrl = `https://admin.da.live/source/${body.da.org}/${body.da.site}${winnerDaPath}.html`;
        const sourceResponse = await fetch(sourceUrl, {
          method: 'GET',
          headers: { 'Authorization': `Bearer ${imsToken}` },
        });

        if (sourceResponse.ok) {
          const sourceHtml = await sourceResponse.text();

          // Create the library page with the same content
          const destUrl = `https://admin.da.live/source/${body.da.org}/${body.da.site}${libraryPath}.html`;
          const formData = new FormData();
          formData.append('data', new Blob([sourceHtml], { type: 'text/html' }));

          const destResponse = await fetch(destUrl, {
            method: 'PUT',
            headers: { 'Authorization': `Bearer ${imsToken}` },
            body: formData,
          });

          if (destResponse.ok) {
            // Trigger preview for the library page
            const previewUrl = `https://admin.hlx.page/preview/${body.da.org}/${body.da.site}/main${libraryPath}`;
            await fetch(previewUrl, {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${imsToken}` },
            });

            result.library = {
              daPath: libraryPath,
              daUrl: `https://da.live/edit#/${body.da.org}/${body.da.site}${libraryPath}`,
              previewUrl: `https://main--${body.da.site}--${body.da.org}.aem.page${libraryPath}`,
            };
            console.log(`Copied DA page to library: ${libraryPath}`);
          } else {
            console.warn(`Failed to copy DA page to library: ${destResponse.status}`);
          }
        } else {
          console.warn(`Failed to read source DA page: ${sourceResponse.status}`);
        }
      } catch (daErr) {
        console.warn('Error copying DA page to library:', daErr);
        // Don't fail the whole request - library copy is optional
      }
    }

    // Cleanup if requested
    if (body.cleanup !== false) {
      const cleanupResult = await cleanupGenerationSession(
        githubFetch,
        body.github.owner,
        body.github.repo,
        body.sessionId,
        env,
        body.da
      );
      result.cleanup = cleanupResult;
    }

    return Response.json(result, { status: 200, headers: corsHeaders(env) });
  } catch (error) {
    return handleError(error, env);
  }
}

/**
 * Handles /block-cleanup endpoint
 * Cleans up a generation session without finalizing
 */
async function handleBlockCleanup(request: Request, env: Env): Promise<Response> {
  try {
    const body = await request.json() as BlockCleanupRequest;

    // Validate required fields
    const missing: string[] = [];
    if (!body.sessionId) missing.push('sessionId');
    if (!body.blockName) missing.push('blockName');
    if (!body.github?.owner) missing.push('github.owner');
    if (!body.github?.repo) missing.push('github.repo');

    // GitHub token: use request token or fall back to env
    const githubToken = body.github?.token || env.GITHUB_TOKEN;
    if (!githubToken) missing.push('github.token (or GITHUB_TOKEN env)');

    if (missing.length > 0) {
      throw new BlockGeneratorError(
        `Missing required fields: ${missing.join(', ')}`,
        'INVALID_REQUEST',
        400
      );
    }

    const githubFetch = createGitHubFetcher(githubToken);

    const cleanupResult = await cleanupGenerationSession(
      githubFetch,
      body.github.owner,
      body.github.repo,
      body.sessionId,
      env,
      body.da
    );

    const response: BlockCleanupResponse = {
      success: true,
      branchesDeleted: [],
      pagesDeleted: [],
    };

    return Response.json(response, { status: 200, headers: corsHeaders(env) });
  } catch (error) {
    return handleError(error, env);
  }
}

/**
 * Helper to cleanup all branches and DA pages for a generation session
 */
async function cleanupGenerationSession(
  githubFetch: (url: string, options?: RequestInit) => Promise<Response>,
  owner: string,
  repo: string,
  sessionId: string,
  env: Env,
  daConfig?: DAConfig
): Promise<{ branchesDeleted: number; pagesDeleted: number }> {
  let branchesDeleted = 0;
  let pagesDeleted = 0;

  // List all branches and find ones matching our pattern: {session}-{opt}-{iter}
  const branchPrefix = `${sessionId}-`;

  try {
    const branchesResponse = await githubFetch(
      `https://api.github.com/repos/${owner}/${repo}/branches?per_page=100`
    );

    if (branchesResponse.ok) {
      const branches = await branchesResponse.json() as Array<{ name: string }>;
      const toDelete = branches.filter(b => b.name.startsWith(branchPrefix));

      for (const branch of toDelete) {
        try {
          const deleteResponse = await githubFetch(
            `https://api.github.com/repos/${owner}/${repo}/git/refs/heads/${branch.name}`,
            { method: 'DELETE' }
          );
          if (deleteResponse.ok || deleteResponse.status === 204) {
            branchesDeleted++;
            console.log(`Deleted branch: ${branch.name}`);
          }
        } catch (e) {
          console.warn(`Failed to delete branch ${branch.name}:`, e);
        }
      }
    }
  } catch (e) {
    console.warn('Failed to list/delete branches:', e);
  }

  // TODO: Delete DA pages (requires listing DA content or tracking created pages)
  // For now, DA cleanup is not implemented

  return { branchesDeleted, pagesDeleted };
}

/**
 * Handles errors and returns appropriate response
 * Now includes actual error message for easier debugging
 */
function handleError(error: unknown, env: Env): Response {
  if (error instanceof BlockGeneratorError) {
    const response: ErrorResponse = {
      success: false,
      error: error.message,
      code: error.code,
    };

    return Response.json(response, {
      status: error.statusCode,
      headers: corsHeaders(env),
    });
  }

  // Unknown error - include actual message for debugging
  const errorMessage = error instanceof Error ? error.message : String(error);
  const errorStack = error instanceof Error ? error.stack : undefined;

  console.error('Unexpected error:', errorMessage);
  if (errorStack) {
    console.error('Stack trace:', errorStack);
  }

  const response: ErrorResponse = {
    success: false,
    error: errorMessage || 'An unexpected error occurred',
    code: 'INTERNAL_ERROR',
  };

  return Response.json(response, {
    status: 500,
    headers: corsHeaders(env),
  });
}

// =============================================================================
// Design System Import Handler
// =============================================================================

/**
 * Push files to a branch, supporting both text and binary (base64) content
 */
async function pushFilesToBranchWithBinary(
  githubFetch: (url: string, options?: RequestInit) => Promise<Response>,
  owner: string,
  repo: string,
  branch: string,
  files: Array<{ path: string; content: string; encoding?: 'utf-8' | 'base64' }>,
  commitMessage: string
): Promise<{ commitSha: string; commitUrl: string }> {
  // Get current commit SHA (ensure branch exists, create from 'main' if not)
  const currentCommitSha = await ensureBranchExists(githubFetch, owner, repo, branch, 'main');

  // Get base tree SHA
  const commitResponse = await githubFetch(
    `https://api.github.com/repos/${owner}/${repo}/git/commits/${currentCommitSha}`
  );

  if (!commitResponse.ok) {
    const error = await commitResponse.text();
    throw new BlockGeneratorError(
      `Failed to get commit: ${commitResponse.status} - ${error}`,
      'GITHUB_API_ERROR',
      commitResponse.status
    );
  }

  const commitData = await commitResponse.json() as { tree: { sha: string } };
  const baseTreeSha = commitData.tree.sha;

  // Create blobs for all files (supporting binary/base64)
  const createBlob = async (content: string, encoding: 'utf-8' | 'base64' = 'utf-8'): Promise<string> => {
    const blobResponse = await githubFetch(
      `https://api.github.com/repos/${owner}/${repo}/git/blobs`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, encoding }),
      }
    );

    if (!blobResponse.ok) {
      const error = await blobResponse.text();
      throw new BlockGeneratorError(
        `Failed to create blob: ${blobResponse.status} - ${error}`,
        'GITHUB_API_ERROR',
        blobResponse.status
      );
    }

    const blobData = await blobResponse.json() as { sha: string };
    return blobData.sha;
  };

  const blobShas = await Promise.all(
    files.map(f => createBlob(f.content, f.encoding || 'utf-8'))
  );

  // Create new tree
  const treeResponse = await githubFetch(
    `https://api.github.com/repos/${owner}/${repo}/git/trees`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        base_tree: baseTreeSha,
        tree: files.map((f, i) => ({
          path: f.path,
          mode: '100644',
          type: 'blob',
          sha: blobShas[i],
        })),
      }),
    }
  );

  if (!treeResponse.ok) {
    const error = await treeResponse.text();
    throw new BlockGeneratorError(
      `Failed to create tree: ${treeResponse.status} - ${error}`,
      'GITHUB_API_ERROR',
      treeResponse.status
    );
  }

  const treeData = await treeResponse.json() as { sha: string };

  // Create commit
  const newCommitResponse = await githubFetch(
    `https://api.github.com/repos/${owner}/${repo}/git/commits`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: commitMessage,
        tree: treeData.sha,
        parents: [currentCommitSha],
      }),
    }
  );

  if (!newCommitResponse.ok) {
    const error = await newCommitResponse.text();
    throw new BlockGeneratorError(
      `Failed to create commit: ${newCommitResponse.status} - ${error}`,
      'GITHUB_API_ERROR',
      newCommitResponse.status
    );
  }

  const newCommitData = await newCommitResponse.json() as { sha: string };

  // Update branch ref
  const updateRefResponse = await githubFetch(
    `https://api.github.com/repos/${owner}/${repo}/git/refs/heads/${branch}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sha: newCommitData.sha }),
    }
  );

  if (!updateRefResponse.ok) {
    const error = await updateRefResponse.text();
    throw new BlockGeneratorError(
      `Failed to update branch ref: ${updateRefResponse.status} - ${error}`,
      'GITHUB_API_ERROR',
      updateRefResponse.status
    );
  }

  return {
    commitSha: newCommitData.sha,
    commitUrl: `https://github.com/${owner}/${repo}/commit/${newCommitData.sha}`,
  };
}

/**
 * Handles /design-system-import endpoint
 * Extracts design system from an external website and pushes styles to GitHub
 */
async function handleDesignSystemImport(request: Request, env: Env): Promise<Response> {
  let browser: ReturnType<typeof puppeteer.launch> extends Promise<infer T> ? T : never;

  try {
    const body = await request.json() as DesignSystemImportRequest;

    // Validate required fields
    const missing: string[] = [];
    if (!body.url) missing.push('url');

    // GitHub config only required if not dryRun
    const githubToken = body.github?.token || env.GITHUB_TOKEN;
    if (!body.dryRun) {
      if (!body.github?.owner) missing.push('github.owner');
      if (!body.github?.repo) missing.push('github.repo');
      if (!githubToken) missing.push('github.token (or GITHUB_TOKEN env)');
    }

    if (missing.length > 0) {
      throw new BlockGeneratorError(
        `Missing required fields: ${missing.join(', ')}`,
        'INVALID_REQUEST',
        400
      );
    }

    // Get Anthropic config for Claude Vision analysis
    const anthropicConfig = getAnthropicConfig(env);
    if (!anthropicConfig) {
      throw new BlockGeneratorError(
        'Anthropic API not configured',
        'INTERNAL_ERROR',
        500
      );
    }

    console.log(`Starting design system import from: ${body.url}`);

    // Launch browser
    browser = await puppeteer.launch(env.BROWSER);
    const page = await browser.newPage();

    await page.setViewport({ width: 1440, height: 900 });

    // Navigate to URL
    console.log('Navigating to URL...');
    await page.goto(body.url, { waitUntil: 'networkidle0', timeout: 30000 });

    // Dismiss cookie banners
    await dismissCookieBanners(page);

    // Wait for page to settle
    await new Promise(r => setTimeout(r, 1000));

    // Step 1: Extract computed styles from browser
    console.log('Extracting computed styles...');
    const computedStyles = await extractDesignComputedStyles(page);

    // Step 2: Take screenshot for Claude Vision analysis
    console.log('Taking screenshot for Claude analysis...');
    const screenshotBuffer = await page.screenshot({ type: 'png', fullPage: false }) as Buffer;
    const screenshotBase64 = screenshotBuffer.toString('base64');

    // Step 3: Get page HTML for stylesheet parsing
    const pageContent = await page.content();

    // Close page (keep browser for potential compression)
    await page.close();

    // Step 4: Parse stylesheets for CSS variables and fonts
    console.log('Parsing stylesheets...');
    const parsedCSS = await parseStylesheets(pageContent, body.url);

    // Step 5: Download fonts
    console.log(`Found ${parsedCSS.fontFaces.length} font faces, downloading...`);
    const { fonts: downloadedFonts, fontBuffers, skippedFamilies } = await downloadFonts(parsedCSS.fontFaces);
    console.log(`Downloaded ${downloadedFonts.length} fonts`);

    // Step 6: Analyze with Claude Vision
    console.log('Analyzing design with Claude Vision...');
    const claudeDesign = await analyzeDesignWithClaude(
      screenshotBase64,
      {
        model: anthropicConfig.useBedrock
          ? (anthropicConfig.bedrockModel || 'anthropic.claude-sonnet-4-20250514-v1:0')
          : 'claude-sonnet-4-20250514',
        apiKey: anthropicConfig.apiKey,
        bedrockToken: anthropicConfig.bedrockToken,
        region: anthropicConfig.bedrockRegion,
      },
      env
    );

    // Step 7: Merge all extracted data
    console.log('Merging extracted design data...');
    const finalDesign = mergeExtractedDesign(computedStyles, parsedCSS, claudeDesign);
    finalDesign.fonts = downloadedFonts;

    // Step 8: Generate CSS files
    console.log('Generating styles.css and fonts.css...');
    const stylesCSS = generateStylesCSS(finalDesign);
    const fontsCSS = generateFontsCSS(downloadedFonts, finalDesign.typography.bodyFont, finalDesign.typography.headingFont, skippedFamilies);
    const fallbackFonts = generateFallbackFonts(
      finalDesign.typography.bodyFont,
      finalDesign.typography.headingFont
    );

    // Combine fallback fonts with styles.css (insert after :root block)
    const finalStylesCSS = stylesCSS.replace(
      '}\n\n@media (width >= 900px)',
      `}\n\n/* fallback fonts */\n${fallbackFonts}\n\n@media (width >= 900px)`
    );

    // Step 9: Prepare files for GitHub
    // Use session ID-based branch if provided, otherwise use main
    const branch = body.sessionId || body.github?.branch || 'main';

    // Generate style-guide CSS for visual design system blocks
    const styleGuideCSS = generateStyleGuideCSS(finalDesign);

    // Generate color-swatch block JS
    const colorSwatchJS = `export default function decorate(block) {
  const rows = block.querySelectorAll(':scope > div');
  rows.forEach((row) => {
    const cells = row.querySelectorAll(':scope > div');
    cells.forEach((cell) => {
      const paras = cell.querySelectorAll('p');
      if (paras.length >= 2) {
        const label = paras[0].textContent.trim();
        const hex = paras[1].textContent.trim();

        // Create swatch element
        const swatch = document.createElement('div');
        swatch.className = 'swatch-color';
        swatch.style.backgroundColor = hex;
        swatch.style.height = '80px';
        swatch.style.borderRadius = '8px';
        swatch.style.marginBottom = '8px';
        swatch.style.border = '1px solid rgba(0,0,0,0.1)';

        // Insert before label
        cell.insertBefore(swatch, paras[0]);

        // Style the paragraphs
        paras[0].style.fontWeight = '600';
        paras[0].style.margin = '4px 0';
        paras[1].style.fontFamily = 'monospace';
        paras[1].style.fontSize = '12px';
        paras[1].style.opacity = '0.7';
        paras[1].style.margin = '4px 0';
      }
    });
  });
}
`;

    const colorSwatchCSS = `.color-swatch {
  margin-bottom: 24px;
}

.color-swatch > div {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
}

.color-swatch > div > div {
  flex: 0 0 140px;
}
`;

    // Image placeholder SVG for style guide
    const imagePlaceholderSVG = `<svg width="1280" height="800" viewBox="0 0 1280 800" fill="none" xmlns="http://www.w3.org/2000/svg">
<rect width="1280" height="800" fill="#F0F0F0"/>
<path fill-rule="evenodd" clip-rule="evenodd" d="M529.954 336.456C529.954 326.991 537.627 319.318 547.092 319.318C556.557 319.318 564.23 326.991 564.23 336.456C564.23 345.92 556.557 353.593 547.092 353.593C537.627 353.593 529.954 345.92 529.954 336.456ZM547.092 313.46C534.392 313.46 524.096 323.755 524.096 336.456C524.096 349.156 534.392 359.451 547.092 359.451C559.792 359.451 570.087 349.156 570.087 336.456C570.087 323.755 559.792 313.46 547.092 313.46ZM611.751 366.971C612.653 366.971 613.504 367.386 614.059 368.097L659.813 426.672L685.27 394.827C685.826 394.131 686.668 393.727 687.558 393.727C688.448 393.727 689.29 394.131 689.846 394.827L759.359 481.782C760.062 482.662 760.198 483.866 759.711 484.88C759.223 485.895 758.197 486.54 757.071 486.54H700.936C700.875 486.54 700.814 486.538 700.754 486.534C700.694 486.538 700.634 486.54 700.573 486.54H522.929C521.809 486.54 520.787 485.902 520.297 484.895C519.806 483.889 519.931 482.691 520.621 481.808L609.443 368.097C609.998 367.386 610.849 366.971 611.751 366.971ZM702.002 480.682L663.52 431.417L687.558 401.346L750.98 480.682H702.002ZM611.751 374.658L528.933 480.682H694.569L611.751 374.658Z" fill="#ABABAB"/>
</svg>`;

    const files: Array<{ path: string; content: string; encoding?: 'utf-8' | 'base64' }> = [
      { path: 'styles/styles.css', content: finalStylesCSS },
      { path: 'styles/fonts.css', content: fontsCSS },
      { path: 'styles/style-guide.css', content: styleGuideCSS },
      { path: 'blocks/color-swatch/color-swatch.js', content: colorSwatchJS },
      { path: 'blocks/color-swatch/color-swatch.css', content: colorSwatchCSS },
      { path: 'icons/image-placeholder.svg', content: imagePlaceholderSVG },
    ];

    // Add font files as base64
    for (const font of downloadedFonts) {
      const buffer = fontBuffers.get(font.localPath);
      if (buffer) {
        const base64Content = arrayBufferToBase64(buffer);
        files.push({
          path: font.localPath,
          content: base64Content,
          encoding: 'base64',
        });
      }
    }

    // Step 10: Push to GitHub (skip if dryRun)
    let githubResult = {
      commitSha: '',
      commitUrl: '',
      branch,
      filesCommitted: files.map(f => f.path),
    };

    const githubFetch = createGitHubFetcher(githubToken);

    if (body.dryRun) {
      console.log(`Dry run mode - skipping GitHub push. Would push ${files.length} files.`);
    } else {
      console.log(`Pushing ${files.length} files to GitHub...`);

      // If using session ID, ensure branch exists (create from main)
      if (body.sessionId) {
        await ensureBranchExists(githubFetch, body.github.owner, body.github.repo, branch, 'main');
      }

      const { commitSha, commitUrl } = await pushFilesToBranchWithBinary(
        githubFetch,
        body.github.owner,
        body.github.repo,
        branch,
        files,
        `Import design system from ${body.url}`
      );

      console.log(`Successfully pushed design system: ${commitUrl}`);
      githubResult = { commitSha, commitUrl, branch, filesCommitted: files.map(f => f.path) };
    }

    // Step 11: Generate preview page if requested
    let previewResult: { previewUrl: string; daPath: string; sampleHtml: string } | undefined;

    if (body.generatePreview && !body.dryRun) {
      console.log('Generating design system preview page...');

      // Generate sample HTML showcasing the design
      const sampleHtml = generateStyleGuideHTML(finalDesign, body.url);

      // Determine DA config - extract from GitHub URL if not provided
      // Parse github owner/repo to determine DA org/site
      const daOrg = body.da?.org || body.github.owner;
      const daSite = body.da?.site || body.github.repo;
      const daBasePath = body.da?.basePath || '/drafts/gen';
      const daPath = `${daBasePath}/${body.sessionId}/design-preview`;

      // Get DA token
      let daToken = body.da?.token;
      if (!daToken && env.DA_CLIENT_ID && env.DA_CLIENT_SECRET && env.DA_SERVICE_TOKEN) {
        daToken = await exchangeDACredentialsForToken(
          env.DA_CLIENT_ID,
          env.DA_CLIENT_SECRET,
          env.DA_SERVICE_TOKEN
        );
      }

      if (daToken) {
        try {
          const daUrl = `https://admin.da.live/source/${daOrg}/${daSite}${daPath}.html`;

          const formData = new FormData();
          const blob = new Blob([sampleHtml], { type: 'text/html' });
          formData.append('data', blob);

          const daResponse = await fetch(daUrl, {
            method: 'PUT',
            headers: { 'Authorization': `Bearer ${daToken}` },
            body: formData,
          });

          if (daResponse.ok) {
            console.log(`Pushed sample content to DA: ${daPath}`);

            // Trigger AEM preview
            const previewUrl = `https://${branch}--${body.github.repo}--${body.github.owner}.aem.page${daPath}`;
            const aemPreviewApiUrl = `https://admin.hlx.page/preview/${body.github.owner}/${body.github.repo}/${branch}${daPath}`;

            try {
              const imsToken = await getDAToken(env);
              let aemResponse = await fetch(aemPreviewApiUrl, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${imsToken}` },
              });

              if (aemResponse.status === 401) {
                clearCachedToken();
                const freshToken = await getDAToken(env);
                aemResponse = await fetch(aemPreviewApiUrl, {
                  method: 'POST',
                  headers: { 'Authorization': `Bearer ${freshToken}` },
                });
              }

              if (aemResponse.ok) {
                console.log(`AEM preview triggered: ${previewUrl}`);
              } else {
                console.warn(`AEM preview trigger failed: ${aemResponse.status}`);
              }
            } catch (aemErr) {
              console.warn('AEM preview trigger error:', aemErr);
            }

            previewResult = {
              previewUrl,
              daPath,
              sampleHtml,
            };
          } else {
            console.warn(`DA push failed: ${daResponse.status}`);
          }
        } catch (daErr) {
          console.warn('DA push error:', daErr);
        }
      } else {
        console.log('No DA token available - skipping preview generation');
      }
    }

    // Build response
    const response: DesignSystemImportResponse = {
      success: true,
      extractedDesign: finalDesign,
      files: {
        stylesCSS: finalStylesCSS,
        fontsCSS,
        fontFiles: downloadedFonts.map(f => f.localPath),
      },
      github: githubResult,
      preview: previewResult,
    };

    return Response.json(response, { headers: corsHeaders(env) });

  } catch (error) {
    console.error('Design system import error:', error);

    if (error instanceof BlockGeneratorError) {
      return Response.json(
        { success: false, error: error.message, code: error.code },
        { status: error.statusCode, headers: corsHeaders(env) }
      );
    }

    return Response.json(
      { success: false, error: String(error), code: 'INTERNAL_ERROR' },
      { status: 500, headers: corsHeaders(env) }
    );
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch (e) {
        console.error('Failed to close browser:', e);
      }
    }
  }
}

/**
 * Handles /design-system-finalize endpoint
 * Merges design system branch to main
 */
async function handleDesignSystemFinalize(request: Request, env: Env): Promise<Response> {
  try {
    interface DesignSystemFinalizeRequest {
      branch: string;
      github: {
        owner: string;
        repo: string;
        token?: string;
      };
    }

    const body = await request.json() as DesignSystemFinalizeRequest;

    // Validate required fields
    const missing: string[] = [];
    if (!body.branch) missing.push('branch');
    if (!body.github?.owner) missing.push('github.owner');
    if (!body.github?.repo) missing.push('github.repo');

    // GitHub token: use request token or fall back to env
    const githubToken = body.github?.token || env.GITHUB_TOKEN;
    if (!githubToken) missing.push('github.token (or GITHUB_TOKEN env)');

    if (missing.length > 0) {
      throw new BlockGeneratorError(
        `Missing required fields: ${missing.join(', ')}`,
        'INVALID_REQUEST',
        400
      );
    }

    const { owner, repo } = body.github;
    const branch = body.branch;

    console.log(`Finalizing design system: merging ${branch} to main`);

    const githubFetch = createGitHubFetcher(githubToken);
    const GITHUB_API = 'https://api.github.com';

    // Get the branch reference to merge
    const branchRefRes = await githubFetch(`${GITHUB_API}/repos/${owner}/${repo}/git/ref/heads/${branch}`);
    if (!branchRefRes.ok) {
      throw new BlockGeneratorError(
        `Branch ${branch} not found`,
        'BRANCH_NOT_FOUND',
        404
      );
    }
    const branchRef = await branchRefRes.json() as { object: { sha: string } };
    const branchSha = branchRef.object.sha;

    // Merge branch into main using merge API
    const mergeRes = await githubFetch(`${GITHUB_API}/repos/${owner}/${repo}/merges`, {
      method: 'POST',
      body: JSON.stringify({
        base: 'main',
        head: branch,
        commit_message: `Merge design system from ${branch}`,
      }),
    });

    if (!mergeRes.ok) {
      const errorBody = await mergeRes.json().catch(() => ({})) as { message?: string };
      throw new BlockGeneratorError(
        `Merge failed: ${errorBody.message || mergeRes.statusText}`,
        'MERGE_FAILED',
        mergeRes.status
      );
    }

    const mergeResult = await mergeRes.json() as { sha: string; html_url?: string };

    // Delete the preview branch after successful merge
    try {
      await githubFetch(`${GITHUB_API}/repos/${owner}/${repo}/git/refs/heads/${branch}`, {
        method: 'DELETE',
      });
      console.log(`Deleted branch: ${branch}`);
    } catch (e) {
      console.warn(`Failed to delete branch ${branch}:`, e);
    }

    console.log(`Successfully merged design system to main: ${mergeResult.sha}`);

    return Response.json({
      success: true,
      merged: {
        sha: mergeResult.sha,
        commitUrl: mergeResult.html_url || `https://github.com/${owner}/${repo}/commit/${mergeResult.sha}`,
        into: 'main',
      },
    }, { headers: corsHeaders(env) });

  } catch (error) {
    console.error('Design system finalize error:', error);

    if (error instanceof BlockGeneratorError) {
      return Response.json(
        { success: false, error: error.message, code: error.code },
        { status: error.statusCode, headers: corsHeaders(env) }
      );
    }

    return Response.json(
      { success: false, error: String(error), code: 'INTERNAL_ERROR' },
      { status: 500, headers: corsHeaders(env) }
    );
  }
}

/**
 * Returns CORS headers
 */
function corsHeaders(env: Env): HeadersInit {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGINS || '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };
}

/**
 * Handles CORS preflight requests
 */
function handleCORS(env: Env): Response {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': env.ALLOWED_ORIGINS || '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    },
  });
}
