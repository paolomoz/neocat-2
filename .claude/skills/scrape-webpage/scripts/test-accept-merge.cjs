const { chromium } = require('playwright');

const extensionPath = '/Users/paolo/excat/neocat-2/workers/block-generator/chrome-extension';
const userDataDir = `/tmp/chrome-ext-merge-${Date.now()}`;

async function testAcceptMerge() {
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

  // Navigate to page
  await page.goto('https://www.virginatlanticcargo.com/gb/en.html');
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(2000);

  // Open popup and configure
  const popupPage = await context.newPage();
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

  // Click Import Design System
  console.log('🎨 Starting design import...');
  await popupPage.click('#import-design-btn');

  // Wait for import to complete
  for (let i = 0; i < 30; i++) {
    await popupPage.waitForTimeout(2000);
    const status = await popupPage.$eval('#design-import-status', el => el.textContent).catch(() => '');
    if (status.includes('imported')) {
      console.log('✅ Design system imported!');
      break;
    }
    if (i % 5 === 0) console.log('  waiting...', i*2, 's');
  }

  // Get preview URL for reference
  const previewUrl = await popupPage.$eval('#design-preview-url-text', el => el.textContent).catch(() => 'N/A');
  console.log('📎 Preview URL:', previewUrl);

  // Click Accept & Merge
  console.log('\n🔀 Clicking Accept & Merge...');
  await popupPage.click('#accept-design-btn');

  // Wait for merge to complete
  console.log('⏳ Waiting for merge...');
  for (let i = 0; i < 15; i++) {
    await popupPage.waitForTimeout(1000);
    const status = await popupPage.$eval('#design-import-status', el => el.textContent).catch(() => '');
    console.log(`  [${i}s] Status: ${status}`);

    if (status.includes('merged successfully')) {
      console.log('✅ Merge successful!');
      break;
    }
    if (status.includes('failed') || status.includes('Error')) {
      console.log('❌ Merge failed:', status);
      break;
    }
  }

  // Wait for redirect to dashboard
  await popupPage.waitForTimeout(2000);

  // Check if we're back at dashboard
  const dashboardVisible = await popupPage.isVisible('#view-dashboard:not(.hidden)');
  const designImportVisible = await popupPage.isVisible('#view-design-import:not(.hidden)');

  console.log('\n📊 Final state:');
  console.log('  Dashboard visible:', dashboardVisible);
  console.log('  Design import visible:', designImportVisible);

  await popupPage.screenshot({ path: '/tmp/after-merge.png' });
  console.log('📸 Screenshot: /tmp/after-merge.png');

  if (dashboardVisible && !designImportVisible) {
    console.log('\n✅ Accept & Merge test passed!');
  } else {
    console.log('\n❌ Accept & Merge test failed - not redirected to dashboard');
  }

  await popupPage.waitForTimeout(3000);
  await context.close();
}

testAcceptMerge().catch(e => console.error('❌ Error:', e));
