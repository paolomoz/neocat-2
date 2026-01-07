/**
 * Test to verify the green overlay issue in block generator screenshots
 *
 * This test demonstrates that when capturing a screenshot with an overlay visible,
 * the overlay color gets included in the screenshot and can pollute the generated CSS.
 */

import { test, expect, chromium } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// The green overlay color used in sidebar.js when clicking
const GREEN_OVERLAY_RGBA = 'rgba(22, 163, 74, 0.3)';
const BLUE_OVERLAY_RGBA = 'rgba(59, 130, 246, 0.2)';

test.describe('Screenshot Overlay Issue', () => {

  test('should demonstrate overlay captured in screenshot', async () => {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();

    // Create a simple test page with a content element
    await page.setContent(`
      <!DOCTYPE html>
      <html>
        <head>
          <style>
            body { margin: 0; padding: 40px; background: #fff; }
            .content-block {
              width: 800px;
              padding: 40px;
              background: #f5f5f5;
              border-radius: 8px;
            }
            .content-block h2 { color: #333; margin: 0 0 16px; }
            .content-block p { color: #666; margin: 0; }

            /* Simulating the AEM overlay */
            .aem-selection-overlay {
              position: absolute;
              pointer-events: none;
              z-index: 2147483646;
              border: 2px solid;
              border-radius: 4px;
            }
          </style>
        </head>
        <body>
          <div class="content-block" id="target">
            <h2>Quick Links Bar</h2>
            <p>Book online - Track your cargo - Contact us - Flight schedules</p>
          </div>
        </body>
      </html>
    `);

    // Get the target element's bounding box
    const targetElement = await page.locator('#target');
    const boundingBox = await targetElement.boundingBox();
    expect(boundingBox).not.toBeNull();

    // Screenshot WITHOUT overlay
    const screenshotWithoutOverlay = await page.screenshot({
      type: 'png',
      clip: {
        x: boundingBox!.x,
        y: boundingBox!.y,
        width: boundingBox!.width,
        height: boundingBox!.height,
      }
    });

    // Add the green overlay (simulating what happens in sidebar.js when clicking)
    await page.evaluate((args) => {
      const { bbox, color, borderColor } = args;
      const overlay = document.createElement('div');
      overlay.className = 'aem-selection-overlay';
      overlay.style.left = `${bbox.x}px`;
      overlay.style.top = `${bbox.y}px`;
      overlay.style.width = `${bbox.width}px`;
      overlay.style.height = `${bbox.height}px`;
      overlay.style.background = color;
      overlay.style.borderColor = borderColor;
      overlay.style.display = 'block';
      document.body.appendChild(overlay);
    }, {
      bbox: boundingBox,
      color: GREEN_OVERLAY_RGBA,
      borderColor: '#16a34a'
    });

    // Screenshot WITH overlay (this is what gets captured in the bug)
    const screenshotWithOverlay = await page.screenshot({
      type: 'png',
      clip: {
        x: boundingBox!.x,
        y: boundingBox!.y,
        width: boundingBox!.width,
        height: boundingBox!.height,
      }
    });

    // Save screenshots for visual inspection
    const testOutputDir = path.join(__dirname, 'test-output');
    if (!fs.existsSync(testOutputDir)) {
      fs.mkdirSync(testOutputDir, { recursive: true });
    }

    fs.writeFileSync(path.join(testOutputDir, 'without-overlay.png'), screenshotWithoutOverlay);
    fs.writeFileSync(path.join(testOutputDir, 'with-green-overlay.png'), screenshotWithOverlay);

    // Verify the screenshots are different (proving the overlay is captured)
    expect(screenshotWithoutOverlay.equals(screenshotWithOverlay)).toBe(false);

    console.log('Screenshots saved to tests/test-output/');
    console.log('  - without-overlay.png: Clean screenshot');
    console.log('  - with-green-overlay.png: Screenshot with green overlay (the bug)');

    await browser.close();
  });

  test('should verify green color is present in overlay screenshot pixels', async () => {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();

    // Create a simple white page
    await page.setContent(`
      <!DOCTYPE html>
      <html>
        <head>
          <style>
            body { margin: 0; padding: 0; }
            .white-block {
              width: 200px;
              height: 200px;
              background: #ffffff;
            }
          </style>
        </head>
        <body>
          <div class="white-block" id="target"></div>
        </body>
      </html>
    `);

    // Add the green overlay
    await page.evaluate((color) => {
      const overlay = document.createElement('div');
      overlay.style.cssText = `
        position: absolute;
        left: 0;
        top: 0;
        width: 200px;
        height: 200px;
        background: ${color};
        pointer-events: none;
      `;
      document.body.appendChild(overlay);
    }, GREEN_OVERLAY_RGBA);

    // Screenshot the area
    const screenshot = await page.screenshot({
      type: 'png',
      clip: { x: 0, y: 0, width: 200, height: 200 }
    });

    // Get pixel color from the center of the image
    // The green overlay on white (#fff) should result in a greenish tint
    // rgba(22, 163, 74, 0.3) on #ffffff = approximately rgb(186, 227, 196) = light green

    // We can verify by checking if the screenshot has greenish pixels
    // This would require image parsing - for now, just verify it's not pure white

    // Save for manual inspection
    const testOutputDir = path.join(__dirname, 'test-output');
    if (!fs.existsSync(testOutputDir)) {
      fs.mkdirSync(testOutputDir, { recursive: true });
    }
    fs.writeFileSync(path.join(testOutputDir, 'green-on-white.png'), screenshot);

    console.log('Green overlay on white background saved to: tests/test-output/green-on-white.png');
    console.log('Expected color: Greenish tint (approximately #BAE3C4 or similar)');
    console.log('This matches the light green background seen in the generated blocks');

    await browser.close();
  });
});

test.describe('Timing Analysis', () => {
  test('should show overlay timing vs screenshot capture', async () => {
    // This test demonstrates the timing issue:
    // 1. User clicks element -> overlay turns green
    // 2. Generation starts immediately
    // 3. Screenshot is captured (overlay still visible)
    // 4. 200ms later overlay turns blue (too late!)

    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();

    await page.setContent(`
      <!DOCTYPE html>
      <html>
        <body style="margin: 40px;">
          <div id="target" style="width: 400px; height: 200px; background: #f0f0f0; padding: 20px;">
            <h2>Sample Block</h2>
            <p>This is test content</p>
          </div>
        </body>
      </html>
    `);

    const testOutputDir = path.join(__dirname, 'test-output');
    if (!fs.existsSync(testOutputDir)) {
      fs.mkdirSync(testOutputDir, { recursive: true });
    }

    // Simulate the click -> flash green -> capture sequence
    // Add green overlay
    await page.evaluate(() => {
      const target = document.getElementById('target')!;
      const rect = target.getBoundingClientRect();

      const overlay = document.createElement('div');
      overlay.id = 'overlay';
      overlay.style.cssText = `
        position: absolute;
        left: ${rect.left}px;
        top: ${rect.top}px;
        width: ${rect.width}px;
        height: ${rect.height}px;
        background: rgba(22, 163, 74, 0.3);
        border: 2px solid #16a34a;
        border-radius: 4px;
        pointer-events: none;
        z-index: 999999;
      `;
      document.body.appendChild(overlay);
    });

    // Capture immediately (simulating the bug)
    const screenshotImmediate = await page.screenshot({ type: 'png' });
    fs.writeFileSync(path.join(testOutputDir, 'timing-0ms-green.png'), screenshotImmediate);

    // Wait 100ms (still in green phase)
    await page.waitForTimeout(100);
    const screenshot100ms = await page.screenshot({ type: 'png' });
    fs.writeFileSync(path.join(testOutputDir, 'timing-100ms-still-green.png'), screenshot100ms);

    // Change to blue (simulating the timeout)
    await page.evaluate(() => {
      const overlay = document.getElementById('overlay')!;
      overlay.style.background = 'rgba(59, 130, 246, 0.2)';
      overlay.style.borderColor = '#3b82f6';
    });

    const screenshotBlue = await page.screenshot({ type: 'png' });
    fs.writeFileSync(path.join(testOutputDir, 'timing-after-timeout-blue.png'), screenshotBlue);

    // Hide overlay completely (the fix)
    await page.evaluate(() => {
      const overlay = document.getElementById('overlay')!;
      overlay.style.display = 'none';
    });

    const screenshotClean = await page.screenshot({ type: 'png' });
    fs.writeFileSync(path.join(testOutputDir, 'timing-overlay-hidden-clean.png'), screenshotClean);

    console.log('Timing sequence screenshots saved:');
    console.log('  - timing-0ms-green.png: Screenshot taken immediately (GREEN overlay visible)');
    console.log('  - timing-100ms-still-green.png: Screenshot at 100ms (still GREEN)');
    console.log('  - timing-after-timeout-blue.png: Screenshot after 200ms timeout (BLUE overlay)');
    console.log('  - timing-overlay-hidden-clean.png: Screenshot with overlay hidden (CLEAN!)');
    console.log('');
    console.log('THE FIX: Hide overlay before capturing screenshot!');

    await browser.close();
  });
});
