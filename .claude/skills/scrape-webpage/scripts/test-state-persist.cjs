const { chromium } = require('playwright');

const extensionPath = '/Users/paolo/excat/neocat-2/workers/block-generator/chrome-extension';
const userDataDir = `/tmp/chrome-ext-persist-${Date.now()}`;

async function testStatePersistence() {
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

  // Verify buttons visible
  const acceptVisible = await popupPage.isVisible('#accept-design-btn');
  console.log('Accept button visible before close:', acceptVisible);

  // Close popup
  console.log('\n📕 Closing popup...');
  await popupPage.close();
  await new Promise(r => setTimeout(r, 1000));

  // Reopen popup
  console.log('📖 Reopening popup...');
  const popupPage2 = await context.newPage();
  await popupPage2.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  await popupPage2.waitForTimeout(1500);

  // Check if design import view is restored
  const designImportVisible = await popupPage2.isVisible('#view-design-import:not(.hidden)');
  const acceptVisible2 = await popupPage2.isVisible('#accept-design-btn');
  const dashboardVisible = await popupPage2.isVisible('#view-dashboard:not(.hidden)');

  console.log('\n📊 After reopening:');
  console.log('  Design import view visible:', designImportVisible);
  console.log('  Accept button visible:', acceptVisible2);
  console.log('  Dashboard visible (should be false):', dashboardVisible);

  await popupPage2.screenshot({ path: '/tmp/popup-reopen.png' });
  console.log('📸 Screenshot: /tmp/popup-reopen.png');

  if (designImportVisible && acceptVisible2 && !dashboardVisible) {
    console.log('\n✅ State persistence works!');
  } else {
    console.log('\n❌ State persistence failed');
  }

  await popupPage2.waitForTimeout(3000);
  await context.close();
}

testStatePersistence().catch(e => console.error('❌ Error:', e));
