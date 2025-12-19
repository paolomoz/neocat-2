import puppeteer, { Browser, Page } from '@cloudflare/puppeteer';

export interface ScreenshotResult {
  screenshot: string; // base64 encoded
  width: number;
  height: number;
}

export interface ExtractedImage {
  src: string;
  alt: string;
  role: 'photo' | 'background' | 'icon';
}

/**
 * Extract actual image URLs from a live page element
 * This captures images that are loaded via JavaScript, CSS backgrounds, etc.
 */
export async function extractLiveImages(
  page: Page,
  selector: string,
  baseUrl: string
): Promise<ExtractedImage[]> {
  return page.evaluate((params: { selector: string; baseUrl: string }) => {
    const { selector, baseUrl } = params;
    const images: Array<{ src: string; alt: string; role: 'photo' | 'background' | 'icon' }> = [];
    const seenUrls = new Set<string>();

    function isPlaceholder(url: string): boolean {
      if (!url) return true;
      const lower = url.toLowerCase();
      return lower.includes('clear.gif') ||
             lower.includes('spacer.gif') ||
             lower.includes('blank.gif') ||
             lower.includes('pixel.gif') ||
             lower.includes('1x1') ||
             lower.includes('placeholder') ||
             (lower.startsWith('data:') && lower.length < 100);
    }

    function resolveUrl(src: string): string {
      if (!src) return '';
      if (src.startsWith('http')) return src;
      if (src.startsWith('data:') && src.length > 100) return src;
      if (src.startsWith('//')) return 'https:' + src;
      try {
        return new URL(src, baseUrl).href;
      } catch {
        return '';
      }
    }

    function addImage(src: string, alt: string, role: 'photo' | 'background' | 'icon') {
      const resolved = resolveUrl(src);
      if (resolved && !isPlaceholder(resolved) && !seenUrls.has(resolved)) {
        seenUrls.add(resolved);
        images.push({ src: resolved, alt, role });
      }
    }

    const container = document.querySelector(selector);
    if (!container) return images;

    // Extract from img elements
    container.querySelectorAll('img').forEach(img => {
      // Try various attributes for lazy-loaded images
      const lazyAttrs = ['data-src', 'data-lazy-src', 'data-original', 'data-lazy', 'data-image'];
      let src = '';

      for (const attr of lazyAttrs) {
        const val = img.getAttribute(attr);
        if (val && !isPlaceholder(val)) {
          src = val;
          break;
        }
      }

      // Try srcset
      if (!src) {
        const srcset = img.getAttribute('srcset') || img.getAttribute('data-srcset');
        if (srcset) {
          const parts = srcset.split(',');
          for (const part of parts) {
            const url = part.trim().split(/\s+/)[0];
            if (url && !isPlaceholder(url)) {
              src = url;
              break;
            }
          }
        }
      }

      // Finally try src
      if (!src) {
        const imgSrc = img.getAttribute('src');
        if (imgSrc && !isPlaceholder(imgSrc)) {
          src = imgSrc;
        }
      }

      // Check currentSrc (the actually displayed image)
      if (!src && img.currentSrc && !isPlaceholder(img.currentSrc)) {
        src = img.currentSrc;
      }

      if (src) {
        const alt = img.getAttribute('alt') || '';
        const parentClass = (img.parentElement?.className || '').toLowerCase();
        let role: 'photo' | 'background' | 'icon' = 'photo';
        if (parentClass.includes('background') || parentClass.includes('hero')) {
          role = 'background';
        } else if (img.width < 100 && img.height < 100) {
          role = 'icon';
        }
        addImage(src, alt, role);
      }
    });

    // Extract from picture source elements
    container.querySelectorAll('picture source').forEach(source => {
      const srcset = source.getAttribute('srcset');
      if (srcset) {
        const url = srcset.split(',')[0]?.trim().split(/\s+/)[0];
        if (url) addImage(url, '', 'photo');
      }
    });

    // Extract CSS background images (computed styles)
    container.querySelectorAll('*').forEach(el => {
      const computed = window.getComputedStyle(el);
      const bgImage = computed.backgroundImage;

      if (bgImage && bgImage !== 'none') {
        // Extract all URLs from background-image (might have multiple)
        const urlMatches = bgImage.matchAll(/url\(['"]?([^'")\s]+)['"]?\)/g);
        for (const match of urlMatches) {
          const url = match[1];
          if (url) addImage(url, 'Background', 'background');
        }
      }

      // Also check data attributes for background images
      const bgAttrs = ['data-background', 'data-bg', 'data-background-image', 'data-image-src'];
      for (const attr of bgAttrs) {
        const val = el.getAttribute(attr);
        if (val) addImage(val, 'Background', 'background');
      }
    });

    return images;
  }, { selector, baseUrl });
}

/**
 * Capture a screenshot of a specific element on a page
 */
export async function captureElementScreenshot(
  browser: Browser,
  url: string,
  selector: string
): Promise<ScreenshotResult> {
  const page = await browser.newPage();

  try {
    // Set viewport to a reasonable desktop size
    await page.setViewport({ width: 1440, height: 900 });

    // Navigate to the page
    await page.goto(url, {
      waitUntil: 'networkidle0',
      timeout: 30000,
    });

    // Wait for the element to be visible
    await page.waitForSelector(selector, { timeout: 10000 });

    // Get the element
    const element = await page.$(selector);
    if (!element) {
      throw new Error(`Element not found: ${selector}`);
    }

    // Get element bounding box
    const boundingBox = await element.boundingBox();
    if (!boundingBox) {
      throw new Error(`Could not get bounding box for: ${selector}`);
    }

    // Capture screenshot of the element
    const screenshotBuffer = await element.screenshot({
      type: 'png',
      encoding: 'base64',
    });

    return {
      screenshot: screenshotBuffer as string,
      width: Math.round(boundingBox.width),
      height: Math.round(boundingBox.height),
    };
  } finally {
    await page.close();
  }
}

/**
 * Capture a full page screenshot with element highlighted
 */
export async function capturePageWithElement(
  browser: Browser,
  url: string,
  selector: string
): Promise<ScreenshotResult> {
  const page = await browser.newPage();

  try {
    await page.setViewport({ width: 1440, height: 900 });

    await page.goto(url, {
      waitUntil: 'networkidle0',
      timeout: 30000,
    });

    // Scroll element into view
    await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (el) {
        el.scrollIntoView({ behavior: 'instant', block: 'center' });
      }
    }, selector);

    // Wait a bit for any animations
    await new Promise(resolve => setTimeout(resolve, 500));

    // Get element bounds for reference
    const element = await page.$(selector);
    const boundingBox = element ? await element.boundingBox() : null;

    // Capture full viewport screenshot
    const screenshotBuffer = await page.screenshot({
      type: 'png',
      encoding: 'base64',
      fullPage: false,
    });

    return {
      screenshot: screenshotBuffer as string,
      width: boundingBox?.width || 1440,
      height: boundingBox?.height || 900,
    };
  } finally {
    await page.close();
  }
}
