import puppeteer, { Browser } from '@cloudflare/puppeteer';

export interface ScreenshotResult {
  screenshot: string; // base64 encoded
  width: number;
  height: number;
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
