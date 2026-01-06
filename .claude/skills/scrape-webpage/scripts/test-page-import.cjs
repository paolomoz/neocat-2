const { chromium } = require('playwright');

const extensionPath = '/Users/paolo/excat/neocat-2/workers/block-generator/chrome-extension';
const userDataDir = `/tmp/chrome-ext-pageimport-${Date.now()}`;

async function testPageImport() {
  console.log('🚀 Launching Chrome with extension...');

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
  let extensionId = null;
  let serviceWorker = null;
  for (let i = 0; i < 10; i++) {
    const workers = await context.serviceWorkers();
    for (const w of workers) {
      if (w.url().includes('chrome-extension://')) {
        extensionId = w.url().split('//')[1].split('/')[0];
        serviceWorker = w;
        break;
      }
    }
    if (extensionId) break;
    await new Promise(r => setTimeout(r, 500));
  }
  console.log('✅ Extension ID:', extensionId);

  // Listen for service worker logs
  if (serviceWorker) {
    serviceWorker.on('console', msg => {
      console.log(`  [sw] ${msg.text()}`);
    });
  }

  // Navigate to page
  console.log('🌐 Loading page...');
  await page.goto('https://www.virginatlanticcargo.com/gb/en.html');
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(2000);

  // Open popup and configure
  console.log('📦 Setting up extension...');
  const popupPage = await context.newPage();

  // Listen for console messages
  popupPage.on('console', msg => {
    if (msg.type() === 'log' || msg.type() === 'error') {
      console.log(`  [popup] ${msg.text()}`);
    }
  });

  await popupPage.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  await popupPage.waitForTimeout(500);

  // Set config
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

  await popupPage.reload();
  await popupPage.waitForTimeout(1000);

  // Click Import This Page
  console.log('📄 Clicking Import This Page...');
  await popupPage.click('#import-page-btn');

  // Wait for analysis
  console.log('⏳ Waiting for page analysis (can take 30-60s)...');
  for (let i = 0; i < 45; i++) {
    await popupPage.waitForTimeout(2000);

    // Check for any error toast first
    const errorVisible = await popupPage.isVisible('#error-toast:not(.hidden)');
    if (errorVisible) {
      const errorMsg = await popupPage.$eval('#error-message', el => el.textContent).catch(() => 'Unknown error');
      console.log('❌ Error toast:', errorMsg);
    }

    // Check if we're in page import view
    const pageImportVisible = await popupPage.isVisible('#view-page-import:not(.hidden)');
    const dashboardVisible = await popupPage.isVisible('#view-dashboard:not(.hidden)');

    if (i === 0) {
      console.log(`  Initial state: pageImport=${pageImportVisible}, dashboard=${dashboardVisible}`);
    }

    if (pageImportVisible) {
      // Get section info
      const sectionName = await popupPage.$eval('#import-section-name', el => el.textContent).catch(() => '?');

      // Check if analysis is still loading
      if (sectionName === 'Analyzing page...' || sectionName === '?') {
        if (i % 5 === 0) console.log('  Still analyzing...', i*2, 's');
        continue;
      }

      console.log('✅ Page import view loaded with data!');

      // Get section info
      const currentSection = await popupPage.$eval('#import-section-current', el => el.textContent).catch(() => '?');
      const totalSections = await popupPage.$eval('#import-section-total', el => el.textContent).catch(() => '?');

      console.log(`  Section ${currentSection} of ${totalSections}: ${sectionName}`);

      // Check screenshot
      const imgSrc = await popupPage.$eval('#section-screenshot-img', el => el.src).catch(() => '');
      console.log(`  Screenshot: ${imgSrc.startsWith('data:image') ? 'Yes (base64)' : (imgSrc || 'None')}`);

      // Check block options
      const optionCount = await popupPage.$$eval('#block-options .block-option', els => els.length).catch(() => 0);
      console.log(`  Block options: ${optionCount} choices`);

      // Log option names
      const optionNames = await popupPage.$$eval('#block-options .block-option-name', els => els.map(e => e.textContent)).catch(() => []);
      if (optionNames.length > 0) {
        console.log(`    Options: ${optionNames.join(', ')}`);
      }

      // Check for section description
      const hasDesc = await popupPage.isVisible('.section-description');
      if (hasDesc) {
        const desc = await popupPage.$eval('.section-description', el => el.textContent.substring(0, 100)).catch(() => '');
        console.log(`  Description: ${desc}...`);
      }

      // Navigate through all sections
      console.log('\n📍 Navigating through all sections...\n');

      for (let sectionIdx = 1; sectionIdx <= parseInt(totalSections); sectionIdx++) {
        const currSection = await popupPage.$eval('#import-section-current', el => el.textContent).catch(() => '?');
        const currName = await popupPage.$eval('#import-section-name', el => el.textContent).catch(() => '?');
        const currOptions = await popupPage.$$eval('#block-options .block-option-name', els => els.map(e => e.textContent)).catch(() => []);
        const currDesc = await popupPage.$eval('.section-description', el => el.textContent.substring(0, 80)).catch(() => '');

        console.log(`Section ${currSection}/${totalSections}: ${currName}`);
        console.log(`  Options: ${currOptions.join(', ')}`);
        if (currDesc) console.log(`  Desc: ${currDesc}...`);

        // Take screenshot of each section
        await popupPage.screenshot({ path: `/tmp/page-import-section-${currSection}.png` });

        // Click next if not on last section
        if (sectionIdx < parseInt(totalSections)) {
          const nextBtn = await popupPage.$('#import-next-btn');
          if (nextBtn) {
            await nextBtn.click();
            await popupPage.waitForTimeout(500);
          }
        }
        console.log('');
      }

      console.log('✅ Navigated through all sections!');

      // Click Finish on last section
      const finishBtnText = await popupPage.$eval('#import-next-btn', el => el.textContent).catch(() => '');
      console.log(`Final button text: "${finishBtnText}"`);

      if (finishBtnText.includes('Finish')) {
        console.log('Clicking Finish to generate page...');
        await popupPage.click('#import-next-btn');

        // Wait for page generation (can take a few seconds)
        console.log('⏳ Waiting for page generation...');
        for (let genWait = 0; genWait < 30; genWait++) {
          await popupPage.waitForTimeout(1000);

          // Check for preview view (success)
          const previewVisible = await popupPage.isVisible('#view-preview:not(.hidden)');
          const dashboardVisible = await popupPage.isVisible('#view-dashboard:not(.hidden)');
          const generatingVisible = await popupPage.isVisible('#view-generating:not(.hidden)');

          if (previewVisible) {
            const previewUrl = await popupPage.$eval('#preview-url-text', el => el.textContent).catch(() => '?');
            const blockName = await popupPage.$eval('#preview-block-name', el => el.textContent).catch(() => '?');
            console.log('✅ Page generated successfully!');
            console.log(`  Name: ${blockName}`);
            console.log(`  Preview URL: ${previewUrl}`);

            // Take screenshot of success screen
            await popupPage.screenshot({ path: '/tmp/page-import-success.png' });
            console.log('📸 Success screenshot: /tmp/page-import-success.png');

            // Click Done to return to dashboard
            await popupPage.click('#accept-block-btn');
            await popupPage.waitForTimeout(500);
            console.log('✅ Returned to dashboard');
            break;
          }

          if (dashboardVisible && genWait > 5) {
            // Check for error toast
            const errorVisible = await popupPage.isVisible('#error-toast:not(.hidden)');
            if (errorVisible) {
              const errorMsg = await popupPage.$eval('#error-message', el => el.textContent).catch(() => 'Unknown');
              console.log('❌ Page generation failed:', errorMsg);
            } else {
              console.log('❌ Returned to dashboard unexpectedly');
            }
            break;
          }

          if (generatingVisible && genWait % 5 === 0) {
            console.log(`  Still generating... ${genWait}s`);
          }
        }
      }

      break;
    }

    if (dashboardVisible && i > 5) {
      console.log('❌ Returned to dashboard (analysis may have failed)');
      break;
    }

    if (i % 5 === 0) console.log('  waiting...', i*2, 's');
  }

  await popupPage.screenshot({ path: '/tmp/page-import.png' });
  console.log('📸 Screenshot: /tmp/page-import.png');

  // Check for any error messages
  const errorVisible = await popupPage.isVisible('#error-toast:not(.hidden)');
  if (errorVisible) {
    const errorMsg = await popupPage.$eval('#error-message', el => el.textContent).catch(() => 'Unknown error');
    console.log('❌ Error:', errorMsg);
  }

  await popupPage.waitForTimeout(5000);
  await context.close();
}

testPageImport().catch(e => console.error('❌ Error:', e));
