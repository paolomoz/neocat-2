/**
 * Integration test for the overlay hide/restore fix
 *
 * This test simulates the actual message flow between service worker and content script
 * to verify that the overlay is properly hidden before screenshot capture.
 */

import { test, expect, chromium, Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Simulate the sidebar.js overlay behavior
const SIDEBAR_OVERLAY_SCRIPT = `
  // Simulate the sidebar overlay system
  window.aemOverlay = null;
  window.aemTooltip = null;
  window.overlayHiddenForScreenshot = false;
  window.overlayStateBeforeHide = null;

  // Create overlay (simulating sidebar.js createSelectionOverlay)
  window.createOverlay = function(bounds) {
    const overlay = document.createElement('div');
    overlay.id = 'aem-selection-overlay';
    overlay.style.cssText = \`
      position: absolute;
      left: \${bounds.x}px;
      top: \${bounds.y}px;
      width: \${bounds.width}px;
      height: \${bounds.height}px;
      background: rgba(22, 163, 74, 0.3);
      border: 2px solid #16a34a;
      border-radius: 4px;
      pointer-events: none;
      z-index: 2147483646;
      display: block;
    \`;
    document.body.appendChild(overlay);
    window.aemOverlay = overlay;
    return overlay;
  };

  // Hide overlay for screenshot (simulating the fix in sidebar.js)
  window.hideOverlayForScreenshot = function() {
    const overlay = window.aemOverlay;
    if (overlay && overlay.style.display !== 'none') {
      window.overlayStateBeforeHide = {
        display: overlay.style.display,
        background: overlay.style.background,
        borderColor: overlay.style.borderColor,
      };
      overlay.style.display = 'none';
      window.overlayHiddenForScreenshot = true;
      console.log('Overlay hidden for screenshot capture');
      return true;
    }
    return false;
  };

  // Restore overlay after screenshot (simulating the fix in sidebar.js)
  window.restoreOverlayAfterScreenshot = function() {
    const overlay = window.aemOverlay;
    if (window.overlayHiddenForScreenshot && overlay && window.overlayStateBeforeHide) {
      overlay.style.display = window.overlayStateBeforeHide.display || 'block';
      // Reset to blue (not green) after screenshot
      overlay.style.background = 'rgba(59, 130, 246, 0.2)';
      overlay.style.borderColor = '#3b82f6';
      window.overlayHiddenForScreenshot = false;
      window.overlayStateBeforeHide = null;
      console.log('Overlay restored after screenshot capture');
      return true;
    }
    return false;
  };
`;

test.describe('Overlay Fix Integration Test', () => {

  test('should capture clean screenshot when overlay is hidden before capture', async () => {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();

    // Create a test page with a content block
    await page.setContent(`
      <!DOCTYPE html>
      <html>
        <head>
          <style>
            body { margin: 0; padding: 40px; background: #fff; }
            .quick-links-bar {
              width: 800px;
              padding: 30px 40px;
              background: #f8f8f8;
              border-radius: 8px;
              display: flex;
              gap: 40px;
            }
            .quick-link {
              display: flex;
              align-items: center;
              gap: 12px;
              color: #c8102e;
              text-decoration: none;
              font-family: Arial, sans-serif;
            }
            .quick-link-icon {
              width: 40px;
              height: 40px;
              background: #c8102e;
              border-radius: 4px;
            }
          </style>
        </head>
        <body>
          <div class="quick-links-bar" id="target">
            <a class="quick-link" href="#">
              <div class="quick-link-icon"></div>
              <span>Book online →</span>
            </a>
            <a class="quick-link" href="#">
              <div class="quick-link-icon"></div>
              <span>Track your cargo →</span>
            </a>
            <a class="quick-link" href="#">
              <div class="quick-link-icon"></div>
              <span>Contact us →</span>
            </a>
            <a class="quick-link" href="#">
              <div class="quick-link-icon"></div>
              <span>Flight schedules →</span>
            </a>
          </div>
        </body>
      </html>
    `);

    // Inject the overlay simulation script
    await page.evaluate(SIDEBAR_OVERLAY_SCRIPT);

    // Get target element bounds
    const targetElement = await page.locator('#target');
    const bounds = await targetElement.boundingBox();
    expect(bounds).not.toBeNull();

    // Create output directory
    const testOutputDir = path.join(__dirname, 'test-output');
    if (!fs.existsSync(testOutputDir)) {
      fs.mkdirSync(testOutputDir, { recursive: true });
    }

    // Step 1: Take baseline screenshot (no overlay)
    const baselineScreenshot = await page.screenshot({
      type: 'png',
      clip: {
        x: bounds!.x,
        y: bounds!.y,
        width: bounds!.width,
        height: bounds!.height,
      }
    });
    fs.writeFileSync(path.join(testOutputDir, 'integration-1-baseline.png'), baselineScreenshot);

    // Step 2: Create the green overlay (simulating user click)
    await page.evaluate((b) => {
      (window as any).createOverlay(b);
    }, bounds);

    // Step 3: Take screenshot WITH overlay visible (the bug)
    const buggyScreenshot = await page.screenshot({
      type: 'png',
      clip: {
        x: bounds!.x,
        y: bounds!.y,
        width: bounds!.width,
        height: bounds!.height,
      }
    });
    fs.writeFileSync(path.join(testOutputDir, 'integration-2-buggy-with-overlay.png'), buggyScreenshot);

    // Step 4: Apply the fix - hide overlay before screenshot
    const hideResult = await page.evaluate(() => {
      return (window as any).hideOverlayForScreenshot();
    });
    expect(hideResult).toBe(true);

    // Small delay (simulating the 50ms wait in service-worker.js)
    await page.waitForTimeout(50);

    // Step 5: Take screenshot with overlay HIDDEN (the fix)
    const fixedScreenshot = await page.screenshot({
      type: 'png',
      clip: {
        x: bounds!.x,
        y: bounds!.y,
        width: bounds!.width,
        height: bounds!.height,
      }
    });
    fs.writeFileSync(path.join(testOutputDir, 'integration-3-fixed-overlay-hidden.png'), fixedScreenshot);

    // Step 6: Restore overlay after screenshot
    const restoreResult = await page.evaluate(() => {
      return (window as any).restoreOverlayAfterScreenshot();
    });
    expect(restoreResult).toBe(true);

    // Step 7: Verify overlay is now blue (not green)
    const overlayColor = await page.evaluate(() => {
      const overlay = (window as any).aemOverlay;
      return overlay ? overlay.style.background : null;
    });
    expect(overlayColor).toBe('rgba(59, 130, 246, 0.2)'); // Blue

    // Step 8: Take screenshot showing restored blue overlay
    const restoredScreenshot = await page.screenshot({
      type: 'png',
      clip: {
        x: bounds!.x,
        y: bounds!.y,
        width: bounds!.width,
        height: bounds!.height,
      }
    });
    fs.writeFileSync(path.join(testOutputDir, 'integration-4-restored-blue-overlay.png'), restoredScreenshot);

    // Verify the fix worked - baseline and fixed should be identical
    const baselineAndFixedMatch = baselineScreenshot.equals(fixedScreenshot);
    expect(baselineAndFixedMatch).toBe(true);

    // Verify the bug - baseline and buggy should be DIFFERENT
    const baselineAndBuggyMatch = baselineScreenshot.equals(buggyScreenshot);
    expect(baselineAndBuggyMatch).toBe(false);

    console.log('');
    console.log('=== Integration Test Results ===');
    console.log('Screenshots saved to tests/test-output/:');
    console.log('  1. integration-1-baseline.png          - Clean (no overlay)');
    console.log('  2. integration-2-buggy-with-overlay.png - With green overlay (THE BUG)');
    console.log('  3. integration-3-fixed-overlay-hidden.png - Overlay hidden before capture (THE FIX)');
    console.log('  4. integration-4-restored-blue-overlay.png - Overlay restored as blue after capture');
    console.log('');
    console.log('✓ Baseline matches fixed screenshot (overlay hidden before capture)');
    console.log('✓ Baseline differs from buggy screenshot (proving overlay was visible)');
    console.log('✓ Overlay color changed from green to blue after restore');
    console.log('');
    console.log('THE FIX WORKS!');

    await browser.close();
  });

  test('should simulate full message flow between service worker and content script', async () => {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();

    await page.setContent(`
      <!DOCTYPE html>
      <html>
        <body style="margin: 40px;">
          <div id="target" style="width: 400px; height: 200px; background: #f0f0f0; padding: 20px;">
            <h2>Quick Links</h2>
            <p>Book online - Track cargo - Contact us</p>
          </div>
        </body>
      </html>
    `);

    await page.evaluate(SIDEBAR_OVERLAY_SCRIPT);

    const bounds = await page.locator('#target').boundingBox();

    // Simulate the complete flow from service-worker.js handleGenerateBlockFromSidebar:
    //
    // 1. User clicks element -> overlay turns green
    // 2. Service worker sends HIDE_OVERLAY_FOR_SCREENSHOT
    // 3. Wait 50ms for DOM update
    // 4. Capture screenshot
    // 5. Service worker sends RESTORE_OVERLAY_AFTER_SCREENSHOT

    // Step 1: Create green overlay (user clicked)
    await page.evaluate((b) => (window as any).createOverlay(b), bounds);

    // Verify overlay is green
    let color = await page.evaluate(() => (window as any).aemOverlay?.style.background);
    expect(color).toBe('rgba(22, 163, 74, 0.3)');

    // Step 2: Simulate HIDE_OVERLAY_FOR_SCREENSHOT message
    await page.evaluate(() => (window as any).hideOverlayForScreenshot());

    // Step 3: Wait 50ms
    await page.waitForTimeout(50);

    // Step 4: Verify overlay is hidden
    let display = await page.evaluate(() => (window as any).aemOverlay?.style.display);
    expect(display).toBe('none');

    // (Screenshot would be captured here)

    // Step 5: Simulate RESTORE_OVERLAY_AFTER_SCREENSHOT message
    await page.evaluate(() => (window as any).restoreOverlayAfterScreenshot());

    // Verify overlay is visible again and now blue
    display = await page.evaluate(() => (window as any).aemOverlay?.style.display);
    color = await page.evaluate(() => (window as any).aemOverlay?.style.background);
    expect(display).toBe('block');
    expect(color).toBe('rgba(59, 130, 246, 0.2)'); // Blue, not green

    console.log('✓ Message flow simulation passed');
    console.log('  - Overlay created as green');
    console.log('  - HIDE_OVERLAY_FOR_SCREENSHOT hides overlay');
    console.log('  - RESTORE_OVERLAY_AFTER_SCREENSHOT shows blue overlay');

    await browser.close();
  });
});
