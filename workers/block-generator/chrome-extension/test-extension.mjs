/**
 * Playwright test script for AEM Block Importer extension
 *
 * This script:
 * 1. Launches Chrome with the extension loaded
 * 2. Navigates to a test page
 * 3. Opens the extension popup
 * 4. Tests the element selection flow
 */

import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function testExtension() {
  console.log('🚀 Launching Chrome with extension...');

  // Launch Chrome with the extension
  const context = await chromium.launchPersistentContext('', {
    headless: false, // Must be false to see the extension
    args: [
      `--disable-extensions-except=${__dirname}`,
      `--load-extension=${__dirname}`,
    ],
    viewport: { width: 1280, height: 800 },
  });

  const pages = context.pages();
  const page = pages[0] || await context.newPage();

  // Get extension ID from service worker
  console.log('🔍 Finding extension ID...');

  let extensionId = null;

  // Wait for service worker to register
  const serviceWorkers = await context.serviceWorkers();
  for (const worker of serviceWorkers) {
    const url = worker.url();
    if (url.includes('chrome-extension://')) {
      extensionId = url.split('//')[1].split('/')[0];
      console.log(`✅ Extension ID: ${extensionId}`);
      break;
    }
  }

  if (!extensionId) {
    // Try waiting for service worker
    console.log('⏳ Waiting for service worker...');
    const worker = await context.waitForEvent('serviceworker', { timeout: 5000 }).catch(() => null);
    if (worker) {
      extensionId = worker.url().split('//')[1].split('/')[0];
      console.log(`✅ Extension ID: ${extensionId}`);
    }
  }

  if (!extensionId) {
    console.log('❌ Could not find extension ID. Extension may not have loaded correctly.');
    console.log('📋 Service workers found:', serviceWorkers.map(w => w.url()));

    // Still continue to show the browser
    console.log('\n🌐 Opening test page anyway...');
  }

  // Navigate to a test website
  console.log('🌐 Navigating to test page...');
  await page.goto('https://www.adobe.com/products/photoshop.html');
  await page.waitForLoadState('networkidle');
  console.log('✅ Page loaded');

  if (extensionId) {
    // Open extension popup in a new tab
    console.log('📦 Opening extension popup...');
    const popupUrl = `chrome-extension://${extensionId}/popup/popup.html`;
    const popupPage = await context.newPage();
    await popupPage.goto(popupUrl);
    console.log(`✅ Popup opened at: ${popupUrl}`);

    // Take screenshot of popup
    await popupPage.screenshot({ path: 'extension-popup.png' });
    console.log('📸 Screenshot saved: extension-popup.png');

    // Check for any console errors
    popupPage.on('console', msg => {
      if (msg.type() === 'error') {
        console.log(`❌ Popup error: ${msg.text()}`);
      }
    });

    // Wait for popup to be ready
    await popupPage.waitForTimeout(1000);

    // Check if setup view is showing
    const setupVisible = await popupPage.isVisible('#view-setup');
    const dashboardVisible = await popupPage.isVisible('#view-dashboard');

    console.log(`\n📊 Extension State:`);
    console.log(`   Setup view visible: ${setupVisible}`);
    console.log(`   Dashboard visible: ${dashboardVisible}`);
  }

  console.log('\n✅ Test browser is running. Extension should be visible in toolbar.');
  console.log('👆 You can interact with the browser manually now.');
  console.log('⏳ Browser will stay open for 5 minutes or until you close it...\n');

  // Keep browser open for manual testing
  await new Promise(resolve => setTimeout(resolve, 5 * 60 * 1000));

  await context.close();
}

testExtension().catch(console.error);
