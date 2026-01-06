const { chromium } = require('playwright');

const extensionPath = '/Users/paolo/excat/neocat-2/workers/block-generator/chrome-extension';
const userDataDir = `/tmp/chrome-ext-pageimport-e2e-${Date.now()}`;

// Test configuration
const TEST_CONFIG = {
  targetUrl: 'https://www.virginatlanticcargo.com/gb/en.html',
  githubRepo: 'paolomoz/neocat-virginatlanticcargo',
  workerUrl: 'https://eds-block-generator.paolo-moz.workers.dev',
  sectionsToImport: 3,
  timeouts: {
    pageLoad: 30000,
    sidebarOpen: 5000,
    analysis: 120000,
    blockGeneration: 90000,
    sectionSelection: 10000,
  }
};

// Logging utility
function log(emoji, ...args) {
  console.log(emoji, new Date().toISOString().split('T')[1].slice(0, 8), ...args);
}

async function testPageImportE2E() {
  log('🚀', 'Launching Chrome with extension...');

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: [
      '--disable-extensions-except=' + extensionPath,
      '--load-extension=' + extensionPath,
      '--no-sandbox',
    ],
    viewport: { width: 1600, height: 1000 },
    timeout: 60000,
  });

  const page = context.pages()[0] || await context.newPage();

  // Enable console logging from the page
  page.on('console', msg => {
    const text = msg.text();
    if (text.includes('[PageImport]') || text.includes('AEM') || text.includes('Error') || text.includes('error')) {
      log('📋', `[page] ${text}`);
    }
  });

  // Wait for extension to load
  let extensionId = null;
  let serviceWorker = null;
  log('⏳', 'Waiting for extension service worker...');

  for (let i = 0; i < 20; i++) {
    const workers = await context.serviceWorkers();
    for (const w of workers) {
      if (w.url().includes('chrome-extension://')) {
        extensionId = w.url().split('//')[1].split('/')[0];
        serviceWorker = w;
        break;
      }
    }
    if (extensionId) break;
    await page.waitForTimeout(500);
  }

  if (!extensionId) {
    log('❌', 'Extension failed to load');
    await context.close();
    return;
  }

  log('✅', 'Extension ID:', extensionId);

  // Log service worker messages
  if (serviceWorker) {
    serviceWorker.on('console', msg => {
      const text = msg.text();
      if (!text.includes('Keepalive')) {
        log('🔧', `[sw] ${text}`);
      }
    });
  }

  // Navigate to target page
  log('🌐', 'Navigating to', TEST_CONFIG.targetUrl);
  await page.goto(TEST_CONFIG.targetUrl, { waitUntil: 'networkidle', timeout: TEST_CONFIG.timeouts.pageLoad });
  await page.waitForTimeout(2000);
  log('✅', 'Page loaded:', await page.title());

  // Take initial screenshot
  await page.screenshot({ path: '/tmp/e2e-01-page-loaded.png', fullPage: false });

  // Open sidebar by clicking the extension popup
  log('📦', 'Opening sidebar via popup...');
  const popupPage = await context.newPage();

  popupPage.on('console', msg => {
    log('📋', `[popup] ${msg.text()}`);
  });

  await popupPage.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  await page.waitForTimeout(500);

  // Click "Open Sidebar" button - this will close the popup
  await popupPage.click('#open-sidebar');

  // Immediately switch to main page since popup will close itself
  await page.bringToFront();

  // Wait a moment for the sidebar to be injected
  await page.waitForTimeout(2000);

  // Wait for sidebar to appear
  log('⏳', 'Waiting for sidebar to inject...');
  await page.waitForSelector('#aem-importer-sidebar', { timeout: TEST_CONFIG.timeouts.sidebarOpen });
  log('✅', 'Sidebar injected');

  await page.screenshot({ path: '/tmp/e2e-02-sidebar-open.png', fullPage: false });

  // Check current view - should be setup if not configured
  const setupView = await page.$('#aem-view-setup:not(.aem-hidden)');
  if (setupView) {
    log('📝', 'Configuring extension with GitHub repo...');

    // Enter GitHub repo
    await page.fill('#aem-github-repo', TEST_CONFIG.githubRepo);
    await page.click('#aem-save-config');

    // Wait for dashboard to appear
    await page.waitForSelector('#aem-view-dashboard:not(.aem-hidden)', { timeout: 5000 });
    log('✅', 'Extension configured');
  } else {
    log('✅', 'Extension already configured');
  }

  await page.waitForTimeout(500);

  await page.screenshot({ path: '/tmp/e2e-03-dashboard.png', fullPage: false });

  // Click "Import This Page"
  log('📄', 'Starting page import...');
  await page.click('#aem-import-page-btn');

  // Wait for page import view
  await page.waitForSelector('#aem-view-page-import:not(.aem-hidden)', { timeout: 5000 });
  log('✅', 'Page import view active');

  await page.screenshot({ path: '/tmp/e2e-04-page-import-start.png', fullPage: false });

  // Now we need to add sections by selecting elements from the page
  // The flow is: click "Add Section" -> select element -> configure -> repeat

  const sectionSelectors = [
    // Hero/header section - look for common hero patterns
    'section.hero, .hero-section, [class*="hero"], header + section, main > section:first-child, main > div:first-child',
    // Second section - usually features or services
    'section:nth-of-type(2), main > section:nth-child(2), main > div:nth-child(2), [class*="feature"], [class*="service"]',
    // Third section - could be cards, testimonials, etc.
    'section:nth-of-type(3), main > section:nth-child(3), main > div:nth-child(3), [class*="card"], [class*="testimonial"]'
  ];

  const sectionsAdded = [];

  for (let i = 0; i < TEST_CONFIG.sectionsToImport; i++) {
    log('➕', `Adding section ${i + 1} of ${TEST_CONFIG.sectionsToImport}...`);

    // Click "Add Section" button
    await page.click('#aem-add-section-btn');
    await page.waitForTimeout(500);

    // We're now in selection mode - need to find and click a suitable element
    // The sidebar shows "Click an element..." text

    // Find a good element to select
    // We'll use JavaScript to find visible sections on the page
    const selectedElement = await page.evaluate(({ selectorList, existingSelections }) => {
      // Helper to check if element is visible
      function isVisible(el) {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 100 &&
               rect.height > 50 &&
               style.display !== 'none' &&
               style.visibility !== 'hidden' &&
               rect.top < window.innerHeight * 2;
      }

      // Helper to check if candidate overlaps with existing selections
      function overlapsWithExisting(candidate) {
        for (const sel of existingSelections) {
          // Check if y ranges overlap
          if (candidate.yStart < sel.yEnd && candidate.yEnd > sel.yStart) {
            return true;
          }
        }
        return false;
      }

      // Try to find main content sections
      const main = document.querySelector('main') || document.querySelector('[role="main"]') || document.body;

      // Get all potential section-like elements
      const candidates = [];

      // Look for semantic sections first
      const sections = main.querySelectorAll('section, article, [class*="section"], [class*="block"], [class*="container"]:not([class*="sidebar"])');
      sections.forEach(el => {
        if (isVisible(el) && !el.closest('#aem-importer-sidebar')) {
          const rect = el.getBoundingClientRect();
          const candidate = {
            el,
            score: rect.height * rect.width,
            yStart: rect.top + window.scrollY,
            yEnd: rect.bottom + window.scrollY
          };
          // Only add if doesn't overlap with existing selections
          if (!overlapsWithExisting(candidate)) {
            candidates.push(candidate);
          }
        }
      });

      // Sort by y position (top to bottom) then by score
      candidates.sort((a, b) => {
        if (Math.abs(a.yStart - b.yStart) < 100) {
          return b.score - a.score;
        }
        return a.yStart - b.yStart;
      });

      // Return the best candidate that doesn't overlap
      for (const c of candidates) {
        if (!overlapsWithExisting(c)) {
          const rect = c.el.getBoundingClientRect();
          // Scroll element into view if needed
          if (rect.top < 0 || rect.bottom > window.innerHeight) {
            c.el.scrollIntoView({ behavior: 'instant', block: 'center' });
          }
          return {
            found: true,
            yStart: c.yStart,
            yEnd: c.yEnd,
            tag: c.el.tagName,
            classes: c.el.className,
            rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
          };
        }
      }

      return { found: false };
    }, { selectorList: sectionSelectors, existingSelections: sectionsAdded });

    if (!selectedElement.found) {
      log('⚠️', `Could not find suitable element for section ${i + 1}`);
      // Cancel selection mode
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);
      continue;
    }

    log('🎯', `Found element: ${selectedElement.tag}.${selectedElement.classes.split(' ')[0]} at y=${Math.round(selectedElement.yStart)}`);

    await page.waitForTimeout(300);

    // Click on the found element (we need to trigger the selection)
    // First, we need to scroll to make sure it's visible
    await page.evaluate((y) => {
      window.scrollTo({ top: y - 200, behavior: 'instant' });
    }, selectedElement.yStart);

    await page.waitForTimeout(300);

    // Click on the element position
    const clickX = selectedElement.rect.x + selectedElement.rect.width / 2;
    const clickY = selectedElement.rect.y + selectedElement.rect.height / 2;

    // Make sure we're not clicking on the sidebar
    const sidebarWidth = await page.$eval('#aem-importer-sidebar', el => el.offsetWidth).catch(() => 400);
    const viewportWidth = page.viewportSize().width;

    if (clickX > viewportWidth - sidebarWidth - 20) {
      // Element might be under sidebar, click more to the left
      await page.mouse.click(viewportWidth - sidebarWidth - 100, clickY);
    } else {
      await page.mouse.click(Math.min(clickX, viewportWidth - sidebarWidth - 50), clickY);
    }

    await page.waitForTimeout(1000);

    // Check if section editor appeared
    const editorVisible = await page.isVisible('#aem-section-editor:not(.aem-hidden)');
    if (editorVisible) {
      log('📝', 'Section editor opened, configuring...');

      // Set section name
      await page.fill('#aem-section-name', `Section ${i + 1}`);
      await page.fill('#aem-section-type', 'content');

      // Select "Generate new block" option
      await page.click('input[name="aem-block-choice"][value="__generate__"]');

      // Save section
      await page.click('#aem-save-section');
      await page.waitForTimeout(500);

      sectionsAdded.push({
        yStart: selectedElement.yStart,
        yEnd: selectedElement.yEnd
      });

      log('✅', `Section ${i + 1} added`);
    } else {
      log('⚠️', 'Section editor did not appear, selection may have failed');
      // Try pressing Escape to cancel and try again
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);
    }

    await page.screenshot({ path: `/tmp/e2e-05-section-${i + 1}-added.png`, fullPage: false });
  }

  // Check how many sections we added
  const sectionCount = await page.$eval('#aem-section-count', el => parseInt(el.textContent) || 0).catch(() => 0);
  log('📊', `Total sections added: ${sectionCount}`);

  if (sectionCount === 0) {
    log('❌', 'No sections were added. Test failed.');
    await page.screenshot({ path: '/tmp/e2e-error-no-sections.png', fullPage: false });
    await context.close();
    return;
  }

  // Click "Finish Import" to start block generation
  log('🏁', 'Clicking Finish Import to generate blocks...');
  await page.click('#aem-footer-action');

  // Now we enter the block generation phase
  // For each section marked as "__generate__", we'll see the generating view, then preview
  let blocksProcessed = 0;
  const maxWait = TEST_CONFIG.timeouts.blockGeneration / 1000;

  for (let blockIdx = 0; blockIdx < sectionCount; blockIdx++) {
    log('⏳', `Waiting for block ${blockIdx + 1} generation...`);

    // Wait for either generating or preview view
    for (let wait = 0; wait < maxWait; wait++) {
      await page.waitForTimeout(1000);

      const generatingVisible = await page.isVisible('#aem-view-generating:not(.aem-hidden)');
      const previewVisible = await page.isVisible('#aem-view-preview:not(.aem-hidden)');
      const dashboardVisible = await page.isVisible('#aem-view-dashboard:not(.aem-hidden)');

      if (previewVisible) {
        log('✅', `Block ${blockIdx + 1} preview ready`);

        // Get preview details
        const blockName = await page.$eval('#aem-preview-name', el => el.textContent).catch(() => '?');
        const previewUrl = await page.$eval('#aem-preview-url-text', el => el.textContent).catch(() => '?');
        log('📦', `Block: ${blockName}`);
        log('🔗', `Preview: ${previewUrl}`);

        await page.screenshot({ path: `/tmp/e2e-06-block-${blockIdx + 1}-preview.png`, fullPage: false });

        // Check if accept button has correct text for page import flow
        const acceptBtnText = await page.$eval('#aem-accept-block', el => el.textContent).catch(() => '');
        log('📝', `Accept button text: "${acceptBtnText}"`);

        // Click accept
        log('✅', 'Accepting block...');
        await page.click('#aem-accept-block');
        await page.waitForTimeout(2000);

        blocksProcessed++;
        break;
      }

      if (dashboardVisible && wait > 10) {
        // Might have returned to dashboard unexpectedly
        const errorVisible = await page.isVisible('[class*="error"]');
        if (errorVisible) {
          const errorText = await page.$eval('[class*="error"]', el => el.textContent).catch(() => 'Unknown error');
          log('❌', 'Error during generation:', errorText);
        }
        log('⚠️', 'Returned to dashboard unexpectedly');
        break;
      }

      if (generatingVisible && wait % 10 === 0) {
        const progressText = await page.$eval('#aem-generating-name', el => el.textContent).catch(() => '...');
        log('⏳', `Still generating: ${progressText} (${wait}s)`);
      }
    }
  }

  log('📊', `Blocks processed: ${blocksProcessed}/${sectionCount}`);

  // After all blocks, we should see the final page preview
  log('⏳', 'Waiting for page composition...');

  for (let wait = 0; wait < 60; wait++) {
    await page.waitForTimeout(1000);

    const previewVisible = await page.isVisible('#aem-view-preview:not(.aem-hidden)');
    const dashboardVisible = await page.isVisible('#aem-view-dashboard:not(.aem-hidden)');
    const generatingVisible = await page.isVisible('#aem-view-generating:not(.aem-hidden)');

    if (previewVisible) {
      const acceptBtnText = await page.$eval('#aem-accept-block', el => el.textContent).catch(() => '');

      if (acceptBtnText.includes('Merge')) {
        log('✅', 'Page composition complete!');

        const previewUrl = await page.$eval('#aem-preview-url-text', el => el.textContent).catch(() => '?');
        log('🔗', 'Final preview URL:', previewUrl);

        await page.screenshot({ path: '/tmp/e2e-07-page-preview.png', fullPage: false });

        // Click merge to main
        log('🔀', 'Merging to main branch...');
        await page.click('#aem-accept-block');
        await page.waitForTimeout(3000);

        // Check for success (should return to dashboard)
        const backToDashboard = await page.isVisible('#aem-view-dashboard:not(.aem-hidden)');
        if (backToDashboard) {
          log('✅', 'Page import completed successfully!');
        } else {
          log('⚠️', 'Did not return to dashboard after merge');
        }

        break;
      }
    }

    if (dashboardVisible && wait > 5) {
      log('⚠️', 'Already at dashboard');
      break;
    }

    if (generatingVisible && wait % 10 === 0) {
      const progressText = await page.$eval('#aem-generating-name', el => el.textContent).catch(() => '...');
      log('⏳', `Still composing: ${progressText} (${wait}s)`);
    }
  }

  await page.screenshot({ path: '/tmp/e2e-08-final.png', fullPage: false });

  log('📸', 'Screenshots saved to /tmp/e2e-*.png');

  // Keep browser open for manual inspection
  log('⏸️', 'Keeping browser open for 30 seconds for inspection...');
  await page.waitForTimeout(30000);

  await context.close();
  log('✅', 'Test complete');
}

testPageImportE2E().catch(e => {
  log('❌', 'Test error:', e.message);
  console.error(e);
  process.exit(1);
});
