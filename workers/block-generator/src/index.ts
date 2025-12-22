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
} from './types';
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

    // Test UI for block-github and block-da
    if (url.pathname === '/test-save' && request.method === 'GET') {
      return handleSaveTestUI(env);
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

## EXTRACTED HTML FROM THE PAGE (this is the actual content - use it!)

\`\`\`html
${htmlPreview}
\`\`\`
${imageRefList}

## EDS Block Requirements

EDS blocks have this structure before decoration:
\`\`\`html
<div class="{block-name}">
  <div><!-- row 1 -->
    <div><!-- cell 1 --></div>
    <div><!-- cell 2 --></div>
  </div>
</div>
\`\`\`

The JS decorate() function transforms this into the final rendered HTML.

## What You Need to Generate

1. **HTML**: EDS block markup with EXACT text, using data-img-ref="N" for images
2. **CSS**: Styles that recreate the visual appearance from the screenshot
3. **JS**: A decorate(block) function that transforms the EDS markup into rendered HTML

## Return Format

Return JSON:
{
  "blockName": "descriptive-block-name",
  "componentType": "hero|cards|columns|tabs|content|etc",
  "html": "<!-- EDS block - use data-img-ref for images -->",
  "css": "/* CSS matching the screenshot design */",
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
 * Handles the block-generate endpoint
 * Accepts multipart form data with screenshot, URL, and HTML
 */
async function handleBlockGenerate(request: Request, env: Env): Promise<Response> {
  try {
    const formData = await request.formData();

    const url = formData.get('url') as string;
    const screenshotFile = formData.get('screenshot') as File;
    let html = formData.get('html') as string;
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
    let screenshotBase64 = arrayBufferToBase64(arrayBuffer);

    // Launch Puppeteer to extract CSS and live images from the page
    let extractedCssStyles: string | undefined;
    let liveImages: ExtractedImage[] = [];

    let screenshotMediaType: 'image/png' | 'image/jpeg' = 'image/png';

    try {
      const browser = await launchBrowserWithRetry(env.BROWSER);
      try {
        // Compress screenshot if too large for Claude API (5MB limit)
        const compressed = await compressImageIfNeeded(browser, screenshotBase64);
        screenshotBase64 = compressed.data;
        screenshotMediaType = compressed.mediaType;

        const page = await browser.newPage();
        await page.setViewport({ width: 1440, height: 900 });
        await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });

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

        // Extract live images - use xpath selector if available, otherwise whole page
        const imageSelector = xpath ? 'body' : 'body';
        try {
          console.log('Extracting live images from page...');
          liveImages = await extractLiveImages(page, imageSelector, url);
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

        await page.close();
      } finally {
        await browser.close();
      }
    } catch (browserError) {
      console.warn('Browser operations failed, continuing without:', browserError);
    }

    // Final validation - we need html at this point
    if (!html) {
      return Response.json(
        { success: false, error: 'Could not extract HTML from provided xpath', code: 'EXTRACTION_FAILED' },
        { status: 400, headers: corsHeaders(env) }
      );
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

    // Build response
    const response: BlockResponse = {
      success: true,
      blockName: enhancedBlock.blockName,
      layoutPattern: enhancedBlock.componentType as any || 'unknown',
      html: enhancedBlock.html,
      js: enhancedBlock.js,
      css: enhancedBlock.css,
      metadata: {
        elementCount: 0,
        hasImages: liveImages.length > 0,
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

    // Parse blocks array
    let blocks: Array<{ html: string; css: string; js: string; blockName?: string; optionIndex: number }>;
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
      // Render each block and capture screenshots
      console.log(`Rendering ${blocks.length} blocks for comparison...`);
      const renderedScreenshots: string[] = [];

      for (let i = 0; i < blocks.length; i++) {
        const block = blocks[i];
        console.log(`  Rendering block ${i + 1}/${blocks.length}...`);
        const screenshot = await renderBlockToScreenshot(
          browser,
          { html: block.html, css: block.css, js: block.js, blockName: block.blockName },
          { width: 1440, height: 900 }
        );
        renderedScreenshots.push(screenshot);
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
          <label for="url">Page URL</label>
          <input type="url" id="url" placeholder="https://example.com/page">
        </div>
        <div class="form-group">
          <label for="screenshot">Screenshot (PNG)</label>
          <input type="file" id="screenshot" accept="image/png">
        </div>
        <div class="form-group">
          <label for="xpath">Element XPath (optional - alternative to HTML)</label>
          <input type="text" id="xpath" placeholder="/html/body/div[1]/section[2]">
        </div>
        <div class="form-group">
          <label for="html">Element HTML (optional if XPath provided)</label>
          <textarea id="html" placeholder="<div class='block'>...</div>"></textarea>
        </div>
        <div class="form-group">
          <label for="refinePrompt">Refine Instructions (optional)</label>
          <textarea id="refinePrompt" placeholder="E.g., 'Fix the background gradient - it should be darker' or 'The button should be rounded with more padding'" style="min-height: 60px;"></textarea>
        </div>
        <div class="button-group">
          <button id="generateBtn" onclick="generate()">Generate Block</button>
          <button id="refineBtn" class="refine" onclick="refine()" disabled>Refine</button>
          <button id="winnerBtn" class="winner" onclick="pickWinner()" disabled>Pick Winner</button>
          <button id="saveGithubBtn" class="save-github" onclick="openGithubModal()" disabled>Save to GitHub</button>
          <button id="saveDaBtn" class="save-da" onclick="openDaModal()" disabled>Save to DA</button>
          <span class="iteration-count" id="iterationCount"></span>
        </div>
        <div id="status" class="status" style="display: none;"></div>

        <div id="winnerResult" class="winner-result" style="display: none;">
          <h3>🏆 <span id="winnerTitle">Winner</span></h3>
          <div class="reasoning" id="winnerReasoning"></div>
          <div class="scores" id="winnerScores"></div>
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
        <div class="tabs">
          <div class="tab active" onclick="switchTab('html')">HTML</div>
          <div class="tab" onclick="switchTab('css')">CSS</div>
          <div class="tab" onclick="switchTab('js')">JS</div>
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
          <div class="preview-header">Live Preview</div>
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
              <iframe id="previewFrame"></iframe>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- GitHub Save Modal -->
  <div id="githubModal" class="save-modal" onclick="if(event.target===this)closeModals()">
    <div class="save-modal-content">
      <h3>🐙 Save to GitHub</h3>
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
        <label>Site URL (for branch name)</label>
        <input type="text" id="gh-siteUrl" placeholder="https://www.example.com">
      </div>
      <div class="form-group">
        <label>GitHub Token</label>
        <input type="password" id="gh-token" placeholder="ghp_...">
      </div>
      <div id="gh-result" class="save-result"></div>
      <div class="button-row">
        <button class="cancel" onclick="closeModals()">Cancel</button>
        <button class="save-github" onclick="saveToGithub()">Push to GitHub</button>
      </div>
    </div>
  </div>

  <!-- DA Save Modal -->
  <div id="daModal" class="save-modal" onclick="if(event.target===this)closeModals()">
    <div class="save-modal-content">
      <h3>📄 Save to DA</h3>
      <div class="row">
        <div class="form-group">
          <label>Organization</label>
          <input type="text" id="da-org" value="paolomoz">
        </div>
        <div class="form-group">
          <label>Site</label>
          <input type="text" id="da-site" value="neocat-2">
        </div>
      </div>
      <div class="form-group">
        <label>Path</label>
        <input type="text" id="da-path" value="/drafts/generated-block">
      </div>
      <div id="da-result" class="save-result"></div>
      <div class="button-row">
        <button class="cancel" onclick="closeModals()">Cancel</button>
        <button class="save-da" onclick="saveToDa()">Save to DA</button>
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
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
      document.querySelector('.tab:nth-child(' + (tab === 'html' ? 1 : tab === 'css' ? 2 : 3) + ')').classList.add('active');
      document.getElementById(tab + 'Tab').classList.add('active');
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

      if (block && !block.loading) {
        document.getElementById('generatedHtml').textContent = block.html;
        document.getElementById('generatedCss').textContent = block.css;
        document.getElementById('generatedJs').textContent = block.js;
        document.getElementById('iterationCount').textContent = 'Option ' + (activeOption + 1) + ' / v' + (activeIteration + 1);
        document.getElementById('refineBtn').disabled = isGenerating;
        document.getElementById('saveGithubBtn').disabled = false;
        document.getElementById('saveDaBtn').disabled = false;
      } else if (block && block.loading) {
        document.getElementById('generatedHtml').textContent = 'Generating...';
        document.getElementById('generatedCss').textContent = '';
        document.getElementById('generatedJs').textContent = '';
        document.getElementById('refineBtn').disabled = true;
        document.getElementById('saveGithubBtn').disabled = true;
        document.getElementById('saveDaBtn').disabled = true;
      } else {
        document.getElementById('generatedHtml').textContent = 'No block generated yet';
        document.getElementById('generatedCss').textContent = '';
        document.getElementById('generatedJs').textContent = '';
        document.getElementById('refineBtn').disabled = true;
        document.getElementById('saveGithubBtn').disabled = true;
        document.getElementById('saveDaBtn').disabled = true;
      }
    }

    function updatePreview() {
      const currentBlock = blocks[activeOption][activeIteration];
      if (!currentBlock || currentBlock.loading) return;

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
      const block = document.querySelector('.block');
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

      const iframe = document.getElementById('previewFrame');
      iframe.srcdoc = previewHtml;
      document.getElementById('previewContainer').style.display = 'block';
    }

    async function generate() {
      const url = document.getElementById('url').value;
      const screenshot = document.getElementById('screenshot').files[0];
      const html = document.getElementById('html').value;
      const xpath = document.getElementById('xpath').value;

      if (!url || !screenshot || (!html && !xpath)) {
        setStatus('Please provide URL, screenshot, and either HTML or XPath', 'error');
        return;
      }

      if (isGenerating) return;
      isGenerating = true;

      // Reset state
      blocks = [[], [], []];
      activeOption = 0;
      activeIteration = 0;

      // Show option tabs and set all to loading state
      document.getElementById('optionTabs').style.display = 'flex';
      document.getElementById('iterationTabs').style.display = 'none';
      for (let i = 0; i < 3; i++) {
        const tab = document.getElementById('optionTab' + i);
        tab.className = 'option-tab loading' + (i === 0 ? ' active' : '');
      }

      setStatus('Generating 3 options × 3 iterations (9 total)...', 'loading');
      document.getElementById('generateBtn').disabled = true;
      document.getElementById('refineBtn').disabled = true;
      document.getElementById('winnerBtn').disabled = true;
      document.getElementById('winnerResult').style.display = 'none';

      // Helper to generate initial block
      async function generateInitial(optionIndex) {
        const formData = new FormData();
        formData.append('url', url);
        formData.append('screenshot', screenshot);
        if (html) formData.append('html', html);
        if (xpath) formData.append('xpath', xpath);

        const response = await fetch('/block-generate', { method: 'POST', body: formData });
        const responseText = await response.text();
        const result = JSON.parse(responseText);

        if (!result.success) throw new Error(result.error);

        return {
          html: result.html,
          css: result.css,
          js: result.js,
          blockName: result.blockName
        };
      }

      // Helper to refine a block
      async function refineBlock(optionIndex, iterationIndex) {
        const prevBlock = blocks[optionIndex][iterationIndex - 1];
        if (!prevBlock || prevBlock.loading) return null;

        const formData = new FormData();
        formData.append('url', url);
        formData.append('screenshot', originalScreenshot);
        if (html) formData.append('html', html);
        if (xpath) formData.append('xpath', xpath);
        formData.append('blockHtml', prevBlock.html);
        formData.append('blockCss', prevBlock.css);
        formData.append('blockJs', prevBlock.js);
        formData.append('blockName', prevBlock.blockName || 'block');

        const response = await fetch('/block-refine', { method: 'POST', body: formData });
        const responseText = await response.text();
        const result = JSON.parse(responseText);

        if (!result.success) throw new Error(result.error);

        return {
          html: result.html,
          css: result.css,
          js: result.js,
          blockName: result.blockName
        };
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

      // Process each option: initial + 2 refinements
      const optionPromises = [0, 1, 2].map(async (optionIndex) => {
        try {
          // Add loading placeholder for iteration 0
          updateUI(optionIndex, 0, null, true);

          // Generate initial
          const initialBlock = await generateInitial(optionIndex);
          updateUI(optionIndex, 0, initialBlock);

          // Start 2 refinements sequentially (each depends on previous)
          for (let refineIter = 1; refineIter <= 2; refineIter++) {
            updateUI(optionIndex, refineIter, null, true);
            try {
              const refinedBlock = await refineBlock(optionIndex, refineIter);
              updateUI(optionIndex, refineIter, refinedBlock);
            } catch (refineError) {
              console.error('Refine error for option ' + optionIndex + ' iter ' + refineIter + ':', refineError);
              // Remove the loading placeholder on error
              blocks[optionIndex].pop();
              updateIterationTabs();
              break; // Stop further refinements for this option
            }
          }

          return { success: true, optionIndex };
        } catch (error) {
          console.error('Generation error for option ' + optionIndex + ':', error);
          updateUI(optionIndex, 0, null, false, true);
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
        if (html) formData.append('html', html);
        if (xpath) formData.append('xpath', xpath);
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
          blocks[activeOption][newIterIndex] = {
            html: result.html,
            css: result.css,
            js: result.js,
            blockName: result.blockName
          };

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
              optionIndex: i
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

    function closeModals() {
      document.getElementById('githubModal').classList.remove('active');
      document.getElementById('daModal').classList.remove('active');
      document.getElementById('gh-result').className = 'save-result';
      document.getElementById('da-result').className = 'save-result';
    }

    function openGithubModal() {
      const currentBlock = blocks[activeOption][activeIteration];
      if (!currentBlock || currentBlock.loading) return;

      // Pre-fill site URL from input
      const siteUrl = document.getElementById('url').value;
      if (siteUrl) document.getElementById('gh-siteUrl').value = siteUrl;

      document.getElementById('gh-result').className = 'save-result';
      document.getElementById('githubModal').classList.add('active');
    }

    function openDaModal() {
      const currentBlock = blocks[activeOption][activeIteration];
      if (!currentBlock || currentBlock.loading) return;

      // Pre-fill path with block name
      const blockName = currentBlock.blockName || 'generated-block';
      document.getElementById('da-path').value = '/drafts/' + blockName;

      document.getElementById('da-result').className = 'save-result';
      document.getElementById('daModal').classList.add('active');
    }

    async function saveToGithub() {
      const currentBlock = blocks[activeOption][activeIteration];
      if (!currentBlock || currentBlock.loading) return;

      const result = document.getElementById('gh-result');
      const btn = document.querySelector('#githubModal .save-github');
      btn.disabled = true;
      btn.textContent = 'Pushing...';

      try {
        const body = {
          owner: document.getElementById('gh-owner').value,
          repo: document.getElementById('gh-repo').value,
          blockName: currentBlock.blockName || 'my-block',
          js: currentBlock.js,
          css: currentBlock.css,
          token: document.getElementById('gh-token').value,
        };

        const siteUrl = document.getElementById('gh-siteUrl').value;
        if (siteUrl) body.siteUrl = siteUrl;

        const res = await fetch('/block-github', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });

        const data = await res.json();

        if (data.success) {
          result.className = 'save-result success';
          result.innerHTML = 'Pushed to branch <strong>' + data.branch + '</strong>! <a href="' + data.commitUrl + '" target="_blank">View commit →</a>';
        } else {
          result.className = 'save-result error';
          result.textContent = 'Error: ' + data.error;
        }
      } catch (err) {
        result.className = 'save-result error';
        result.textContent = 'Error: ' + err.message;
      }

      btn.disabled = false;
      btn.textContent = 'Push to GitHub';
    }

    async function saveToDa() {
      const currentBlock = blocks[activeOption][activeIteration];
      if (!currentBlock || currentBlock.loading) return;

      const result = document.getElementById('da-result');
      const btn = document.querySelector('#daModal .save-da');
      btn.disabled = true;
      btn.textContent = 'Saving...';

      try {
        const res = await fetch('/block-da', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            org: document.getElementById('da-org').value,
            site: document.getElementById('da-site').value,
            path: document.getElementById('da-path').value,
            html: currentBlock.html,
          })
        });

        const data = await res.json();

        if (data.success) {
          result.className = 'save-result success';
          result.innerHTML = 'Saved! <a href="' + data.pageUrl + '" target="_blank">Open in DA →</a> | <a href="' + data.previewUrl + '" target="_blank">Preview →</a>';
        } else {
          result.className = 'save-result error';
          result.textContent = 'Error: ' + data.error;
        }
      } catch (err) {
        result.className = 'save-result error';
        result.textContent = 'Error: ' + err.message;
      }

      btn.disabled = false;
      btn.textContent = 'Save to DA';
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
 * Returns the test UI HTML page for block-github and block-da
 */
function handleSaveTestUI(env: Env): Response {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Block Save Test UI</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
      min-height: 100vh;
      padding: 20px;
      color: #fff;
    }
    .container { max-width: 1200px; margin: 0 auto; }
    h1 { margin-bottom: 10px; font-size: 28px; }
    .subtitle { color: #888; margin-bottom: 30px; }
    .panels { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
    @media (max-width: 900px) { .panels { grid-template-columns: 1fr; } }
    .panel {
      background: rgba(255,255,255,0.05);
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 12px;
      padding: 24px;
    }
    .panel h2 {
      margin-bottom: 20px;
      font-size: 18px;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .panel h2 .icon { font-size: 24px; }
    .form-group { margin-bottom: 16px; }
    label {
      display: block;
      margin-bottom: 6px;
      font-size: 13px;
      color: #aaa;
      font-weight: 500;
    }
    input, textarea {
      width: 100%;
      padding: 12px;
      background: rgba(0,0,0,0.3);
      border: 1px solid rgba(255,255,255,0.15);
      border-radius: 8px;
      color: #fff;
      font-size: 14px;
    }
    input:focus, textarea:focus {
      outline: none;
      border-color: #4CAF50;
    }
    textarea {
      min-height: 120px;
      font-family: 'Monaco', 'Menlo', monospace;
      font-size: 12px;
    }
    button {
      width: 100%;
      padding: 14px;
      border: none;
      border-radius: 8px;
      font-size: 15px;
      font-weight: 600;
      cursor: pointer;
      transition: transform 0.1s, box-shadow 0.2s;
    }
    button:hover { transform: translateY(-1px); }
    button:active { transform: translateY(0); }
    button:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }
    .btn-github {
      background: linear-gradient(135deg, #24292e 0%, #1a1e22 100%);
      color: white;
      border: 1px solid #444;
    }
    .btn-da {
      background: linear-gradient(135deg, #eb1000 0%, #c40d00 100%);
      color: white;
    }
    .result {
      margin-top: 16px;
      padding: 16px;
      border-radius: 8px;
      font-size: 13px;
      display: none;
    }
    .result.success {
      display: block;
      background: rgba(76, 175, 80, 0.2);
      border: 1px solid #4CAF50;
    }
    .result.error {
      display: block;
      background: rgba(244, 67, 54, 0.2);
      border: 1px solid #f44336;
    }
    .result a {
      color: #4CAF50;
      text-decoration: none;
    }
    .result a:hover { text-decoration: underline; }
    pre {
      background: rgba(0,0,0,0.3);
      padding: 12px;
      border-radius: 6px;
      overflow-x: auto;
      margin-top: 10px;
      font-size: 11px;
    }
    .row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Block Save Test UI</h1>
    <p class="subtitle">Test /block-github and /block-da endpoints</p>

    <div class="panels">
      <!-- GitHub Panel -->
      <div class="panel">
        <h2><span class="icon">&#128025;</span> Push to GitHub</h2>
        <form id="github-form">
          <div class="row">
            <div class="form-group">
              <label>Owner</label>
              <input type="text" id="gh-owner" value="paolomoz" required>
            </div>
            <div class="form-group">
              <label>Repo</label>
              <input type="text" id="gh-repo" value="neocat-2" required>
            </div>
          </div>
          <div class="form-group">
            <label>Site URL (generates branch name)</label>
            <input type="text" id="gh-siteUrl" placeholder="https://www.example.com">
          </div>
          <div class="form-group">
            <label>Block Name</label>
            <input type="text" id="gh-blockName" value="my-block" required>
          </div>
          <div class="form-group">
            <label>JavaScript</label>
            <textarea id="gh-js" required>export default function decorate(block) {
  block.classList.add('decorated');
  console.log('Block decorated!');
}</textarea>
          </div>
          <div class="form-group">
            <label>CSS</label>
            <textarea id="gh-css" required>.my-block {
  padding: 2rem;
  background: #f5f5f5;
  border-radius: 8px;
}</textarea>
          </div>
          <div class="form-group">
            <label>GitHub Token</label>
            <input type="password" id="gh-token" required>
          </div>
          <button type="submit" class="btn-github">Push to GitHub</button>
          <div id="gh-result" class="result"></div>
        </form>
      </div>

      <!-- DA Panel -->
      <div class="panel">
        <h2><span class="icon">&#128196;</span> Save to DA</h2>
        <form id="da-form">
          <div class="row">
            <div class="form-group">
              <label>Organization</label>
              <input type="text" id="da-org" value="paolomoz" required>
            </div>
            <div class="form-group">
              <label>Site</label>
              <input type="text" id="da-site" value="neocat-2" required>
            </div>
          </div>
          <div class="form-group">
            <label>Path</label>
            <input type="text" id="da-path" value="/drafts/test-block" required>
          </div>
          <div class="form-group">
            <label>HTML Content</label>
            <textarea id="da-html" required><body>
<header></header>
<main>
  <div>
    <div class="my-block">
      <div>
        <div>
          <h1>Hello World</h1>
          <p>This is a test block.</p>
        </div>
      </div>
    </div>
  </div>
</main>
<footer></footer>
</body></textarea>
          </div>
          <button type="submit" class="btn-da">Save to DA</button>
          <div id="da-result" class="result"></div>
        </form>
      </div>
    </div>
  </div>

  <script>
    const API_BASE = '';

    // Check for pre-filled data from /test page
    (function loadDataFromUrl() {
      const params = new URLSearchParams(window.location.search);
      const encodedData = params.get('data');
      if (encodedData) {
        try {
          const data = JSON.parse(decodeURIComponent(escape(atob(encodedData))));

          // Pre-fill GitHub form
          if (data.blockName) document.getElementById('gh-blockName').value = data.blockName;
          if (data.js) document.getElementById('gh-js').value = data.js;
          if (data.css) document.getElementById('gh-css').value = data.css;
          if (data.siteUrl) document.getElementById('gh-siteUrl').value = data.siteUrl;

          // Pre-fill DA form with the HTML
          if (data.html) document.getElementById('da-html').value = data.html;

          // Update CSS block name to match
          if (data.blockName) {
            document.getElementById('gh-css').value = data.css.replace(/\\.my-block/g, '.' + data.blockName);
          }
        } catch (e) {
          console.error('Failed to parse data from URL:', e);
        }
      }
    })();

    document.getElementById('github-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = e.target.querySelector('button');
      const result = document.getElementById('gh-result');
      btn.disabled = true;
      btn.textContent = 'Pushing...';
      result.className = 'result';

      try {
        const body = {
          owner: document.getElementById('gh-owner').value,
          repo: document.getElementById('gh-repo').value,
          blockName: document.getElementById('gh-blockName').value,
          js: document.getElementById('gh-js').value,
          css: document.getElementById('gh-css').value,
          token: document.getElementById('gh-token').value,
        };

        const siteUrl = document.getElementById('gh-siteUrl').value;
        if (siteUrl) body.siteUrl = siteUrl;

        const res = await fetch(API_BASE + '/block-github', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });

        const data = await res.json();

        if (data.success) {
          result.className = 'result success';
          result.innerHTML = \`
            <strong>Success!</strong><br>
            Branch: <code>\${data.branch}</code><br>
            <a href="\${data.commitUrl}" target="_blank">View Commit &rarr;</a>
            <pre>\${JSON.stringify(data, null, 2)}</pre>
          \`;
        } else {
          result.className = 'result error';
          result.innerHTML = \`<strong>Error:</strong> \${data.error}<pre>\${JSON.stringify(data, null, 2)}</pre>\`;
        }
      } catch (err) {
        result.className = 'result error';
        result.innerHTML = \`<strong>Error:</strong> \${err.message}\`;
      }

      btn.disabled = false;
      btn.textContent = 'Push to GitHub';
    });

    document.getElementById('da-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = e.target.querySelector('button');
      const result = document.getElementById('da-result');
      btn.disabled = true;
      btn.textContent = 'Saving...';
      result.className = 'result';

      try {
        const res = await fetch(API_BASE + '/block-da', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            org: document.getElementById('da-org').value,
            site: document.getElementById('da-site').value,
            path: document.getElementById('da-path').value,
            html: document.getElementById('da-html').value,
          })
        });

        const data = await res.json();

        if (data.success) {
          result.className = 'result success';
          result.innerHTML = \`
            <strong>Success!</strong><br>
            <a href="\${data.pageUrl}" target="_blank">Open in DA &rarr;</a><br>
            <a href="\${data.previewUrl}" target="_blank">Preview &rarr;</a>
            <pre>\${JSON.stringify(data, null, 2)}</pre>
          \`;
        } else {
          result.className = 'result error';
          result.innerHTML = \`<strong>Error:</strong> \${data.error}<pre>\${JSON.stringify(data, null, 2)}</pre>\`;
        }
      } catch (err) {
        result.className = 'result error';
        result.innerHTML = \`<strong>Error:</strong> \${err.message}\`;
      }

      btn.disabled = false;
      btn.textContent = 'Save to DA';
    });
  </script>
</body>
</html>`;

  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
    },
  });
}

/**
 * Returns the test UI HTML page
 */
function handleTestUI(env: Env): Response {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>EDS Block Generator</title>
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      max-width: 800px;
      margin: 0 auto;
      padding: 40px 20px;
      background: #f5f5f5;
    }
    h1 { margin: 0 0 8px; }
    .subtitle { color: #666; margin: 0 0 32px; }
    .form-group { margin-bottom: 20px; }
    label { display: block; font-weight: 600; margin-bottom: 8px; }
    input[type="text"] {
      width: 100%;
      padding: 12px;
      font-size: 16px;
      border: 1px solid #ccc;
      border-radius: 6px;
    }
    input[type="text"]:focus {
      outline: none;
      border-color: #3b63fb;
      box-shadow: 0 0 0 3px rgba(59, 99, 251, 0.1);
    }
    .buttons { display: flex; gap: 12px; margin-top: 24px; }
    button {
      padding: 12px 24px;
      font-size: 16px;
      font-weight: 600;
      border: none;
      border-radius: 6px;
      cursor: pointer;
      transition: background-color 0.2s;
    }
    .btn-primary {
      background: #3b63fb;
      color: white;
    }
    .btn-primary:hover { background: #1d3ecf; }
    .btn-secondary {
      background: #e0e0e0;
      color: #333;
    }
    .btn-secondary:hover { background: #d0d0d0; }
    .hint {
      font-size: 13px;
      color: #888;
      margin-top: 6px;
    }
    .loading {
      display: none;
      color: #666;
      margin-top: 20px;
    }
    .error {
      background: #fee;
      border: 1px solid #fcc;
      color: #c00;
      padding: 12px;
      border-radius: 6px;
      margin-top: 20px;
      display: none;
    }
  </style>
</head>
<body>
  <h1>EDS Block Generator</h1>
  <p class="subtitle">Generate AEM Edge Delivery Services blocks from any webpage</p>

  <form id="generateForm">
    <div class="form-group">
      <label for="url">Page URL</label>
      <input type="text" id="url" name="url" placeholder="https://example.com" required>
      <p class="hint">The webpage to extract content from</p>
    </div>

    <div class="form-group">
      <label for="selector">CSS Selector</label>
      <input type="text" id="selector" name="selector" placeholder=".hero, #main-content, article" required>
      <p class="hint">CSS selector for the content block to convert</p>
    </div>

    <div class="buttons">
      <button type="submit" class="btn-primary" id="previewBtn">Preview in Browser</button>
      <button type="button" class="btn-secondary" id="jsonBtn">Get JSON</button>
    </div>
  </form>

  <p class="loading" id="loading">Generating block...</p>
  <div class="error" id="error"></div>

  <script>
    const form = document.getElementById('generateForm');
    const loading = document.getElementById('loading');
    const error = document.getElementById('error');

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      await makeRequest('/preview', true);
    });

    document.getElementById('jsonBtn').addEventListener('click', async () => {
      await makeRequest('/generate', false);
    });

    async function makeRequest(endpoint, openInNewTab) {
      const url = document.getElementById('url').value;
      const selector = document.getElementById('selector').value;

      loading.style.display = 'block';
      error.style.display = 'none';

      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url, selector })
        });

        if (endpoint === '/preview') {
          const html = await response.text();
          if (!response.ok) {
            throw new Error('Failed to generate preview');
          }
          const newWindow = window.open('', '_blank');
          if (!newWindow) {
            throw new Error('Popup blocked. Please allow popups for this site.');
          }
          newWindow.document.write(html);
          newWindow.document.close();
        } else {
          const json = await response.json();
          if (json.success) {
            const newWindow = window.open('', '_blank');
            if (!newWindow) {
              throw new Error('Popup blocked. Please allow popups for this site.');
            }
            newWindow.document.write('<pre>' + JSON.stringify(json, null, 2) + '</pre>');
            newWindow.document.close();
          } else {
            throw new Error(json.error);
          }
        }
      } catch (err) {
        error.textContent = err.message;
        error.style.display = 'block';
      } finally {
        loading.style.display = 'none';
      }
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

/**
 * Handles errors and returns appropriate response
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

  // Unknown error
  console.error('Unexpected error:', error);

  const response: ErrorResponse = {
    success: false,
    error: 'An unexpected error occurred',
    code: 'INTERNAL_ERROR',
  };

  return Response.json(response, {
    status: 500,
    headers: corsHeaders(env),
  });
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
