const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const extensionPath = '/Users/paolo/excat/neocat-2/workers/block-generator/chrome-extension';

// Use a temp dir for fresh profile each time
const userDataDir = `/tmp/chrome-ext-test-${Date.now()}`;

async function testBlockSelection() {
  console.log('🚀 Launching Chrome with extension...');
  console.log('📁 User data dir:', userDataDir);

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: [
      '--disable-extensions-except=' + extensionPath,
      '--load-extension=' + extensionPath,
    ],
    viewport: { width: 1400, height: 900 },
  });

  const page = context.pages()[0] || await context.newPage();

  // Wait for extension
  console.log('⏳ Waiting for extension...');
  let extensionId = null;
  for (let i = 0; i < 10; i++) {
    const workers = await context.serviceWorkers();
    for (const w of workers) {
      if (w.url().includes('chrome-extension://')) {
        extensionId = w.url().split('//')[1].split('/')[0];
        break;
      }
    }
    if (extensionId) break;
    await new Promise(r => setTimeout(r, 500));
  }
  console.log('✅ Extension ID:', extensionId);

  // Navigate to Virgin Atlantic Cargo page
  console.log('🌐 Loading Virgin Atlantic Cargo page...');
  await page.goto('https://www.virginatlanticcargo.com/gb/en.html');
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(3000);
  console.log('✅ Page loaded');

  // Dismiss any cookie banners
  try {
    const acceptBtn = await page.$('button:has-text("Accept"), [id*="accept"], [class*="accept"]');
    if (acceptBtn) {
      await acceptBtn.click();
      await page.waitForTimeout(1000);
      console.log('✅ Cookie banner dismissed');
    }
  } catch (e) {
    console.log('ℹ️ No cookie banner or already dismissed');
  }

  // Open popup and configure
  console.log('📦 Setting up extension...');
  const popupPage = await context.newPage();
  await popupPage.goto('chrome-extension://' + extensionId + '/popup/popup.html');
  await popupPage.waitForTimeout(500);

  // Fill in simplified config directly to storage (no token - backend uses .env)
  await popupPage.evaluate(() => {
    chrome.storage.local.set({
      'aem_importer_config': {
        githubRepo: 'paolomoz/neocat-virginatlanticcargo',
        daOrg: 'paolomoz',
        daSite: 'neocat-virginatlanticcargo',
        workerUrl: 'http://localhost:8787'
      }
    });
  });
  console.log('✅ Config saved to storage (simplified - no token)');

  // Reload popup to show dashboard
  await popupPage.reload();
  await popupPage.waitForTimeout(1000);

  // Take screenshot of dashboard
  await popupPage.screenshot({ path: '/tmp/extension-dashboard.png' });
  console.log('📸 Dashboard screenshot: /tmp/extension-dashboard.png');

  // Check if dashboard is visible
  const dashboardVisible = await popupPage.isVisible('#view-dashboard');
  console.log('📊 Dashboard visible:', dashboardVisible);

  // Listen for popup console messages
  popupPage.on('console', msg => {
    console.log('  [popup]', msg.type(), msg.text());
  });

  // Get service worker and listen to its console
  const workers = await context.serviceWorkers();
  for (const worker of workers) {
    if (worker.url().includes(extensionId)) {
      console.log('📡 Listening to service worker console...');
      worker.on('console', msg => {
        console.log('  [sw]', msg.type(), msg.text());
      });
    }
  }

  // Click Select Block button
  console.log('🎯 Clicking Select Block button...');
  await popupPage.click('#select-block-btn');
  await popupPage.waitForTimeout(2000);

  // Take screenshot of selection mode
  await popupPage.screenshot({ path: '/tmp/extension-selection-mode.png' });
  console.log('📸 Selection mode screenshot: /tmp/extension-selection-mode.png');

  // Switch to main page and check for overlay
  await page.bringToFront();
  await page.waitForTimeout(1000);

  // Check if selection overlay is injected
  const hasOverlayClass = await page.evaluate(() => {
    return document.body.classList.contains('aem-block-importer-active');
  });
  console.log('🎨 Selection overlay active:', hasOverlayClass);

  // Move mouse over elements to test hover
  console.log('🖱️ Testing hover highlights...');

  // Find some elements to hover over
  const sections = await page.locator('section, [class*="section"], [class*="hero"]').all();
  console.log('Found', sections.length, 'potential block elements');

  if (sections.length > 0) {
    // Hover over first few sections
    for (let i = 0; i < Math.min(3, sections.length); i++) {
      const box = await sections[i].boundingBox();
      if (box && box.height > 50) {
        await page.mouse.move(box.x + box.width/2, box.y + box.height/2);
        await page.waitForTimeout(800);
        console.log('  Hovering over element', i+1, 'at y=' + Math.round(box.y), 'height=' + Math.round(box.height));
      }
    }
  }

  // Take screenshot showing hover highlight
  await page.screenshot({ path: '/tmp/extension-hover.png', fullPage: false });
  console.log('📸 Hover screenshot: /tmp/extension-hover.png');

  // Check if overlay element exists
  const overlayExists = await page.evaluate(() => {
    return !!document.querySelector('.aem-block-importer-overlay');
  });
  console.log('🔲 Overlay element exists:', overlayExists);

  // Check for tooltip
  const tooltipExists = await page.evaluate(() => {
    return !!document.querySelector('.aem-block-importer-tooltip');
  });
  console.log('💬 Tooltip exists:', tooltipExists);

  // If overlay exists, try clicking to select
  if (overlayExists) {
    console.log('🖱️ Clicking to select element...');

    // First scroll down to find a good section
    await page.evaluate(() => window.scrollBy(0, 300));
    await page.waitForTimeout(500);

    // Move mouse to find a block
    await page.mouse.move(700, 400);
    await page.waitForTimeout(500);

    // Screenshot before click
    await page.screenshot({ path: '/tmp/extension-before-click.png' });
    console.log('📸 Before click screenshot: /tmp/extension-before-click.png');

    // Click to select
    await page.mouse.click(700, 400);
    console.log('✅ Element clicked - waiting for generation...');

    // Wait for generation to start and monitor progress
    for (let i = 0; i < 60; i++) {
      await page.waitForTimeout(2000);

      // Check popup for progress
      await popupPage.bringToFront();
      await popupPage.screenshot({ path: `/tmp/extension-progress-${i}.png` });

      // Check if we're on preview view
      const previewVisible = await popupPage.isVisible('#view-preview').catch(() => false);
      const generatingVisible = await popupPage.isVisible('#view-generating').catch(() => false);
      const errorToast = await popupPage.isVisible('#error-toast').catch(() => false);

      console.log(`  [${i*2}s] Generating: ${generatingVisible}, Preview: ${previewVisible}, Error: ${errorToast}`);

      if (previewVisible) {
        console.log('✅ Generation complete! Preview is ready.');
        await popupPage.screenshot({ path: '/tmp/extension-preview-final.png' });

        // Get preview URL
        const previewUrl = await popupPage.$eval('#preview-url-text', el => el.textContent).catch(() => 'N/A');
        console.log('🔗 Preview URL:', previewUrl);
        break;
      }

      if (errorToast) {
        const errorMsg = await popupPage.$eval('#error-message', el => el.textContent).catch(() => 'Unknown error');
        console.log('❌ Error:', errorMsg);
        break;
      }

      // If still on dashboard after a while, something went wrong
      const dashboardVisible = await popupPage.isVisible('#view-dashboard').catch(() => false);
      if (dashboardVisible && i > 5) {
        console.log('⚠️ Still on dashboard - generation may have failed silently');
        break;
      }
    }

    // Final screenshot
    await page.bringToFront();
    await page.screenshot({ path: '/tmp/extension-after-generation.png' });
    console.log('📸 After generation screenshot: /tmp/extension-after-generation.png');
  }

  console.log('\n✅ Block selection test complete!');
  console.log('🎯 Browser staying open for 3 minutes - interact manually...');

  await new Promise(r => setTimeout(r, 180000));
  await context.close();
}

testBlockSelection().catch(e => console.error('❌ Error:', e));
