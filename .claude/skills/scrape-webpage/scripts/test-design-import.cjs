const { chromium } = require('playwright');

const extensionPath = '/Users/paolo/excat/neocat-2/workers/block-generator/chrome-extension';
const userDataDir = `/tmp/chrome-ext-design-${Date.now()}`;

async function testDesignImport() {
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

  // Navigate to Virgin Atlantic Cargo
  console.log('🌐 Loading page...');
  await page.goto('https://www.virginatlanticcargo.com/gb/en.html');
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(2000);

  // Open popup and configure
  console.log('📦 Setting up extension...');
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

  // Check dashboard is visible
  const dashboardVisible = await popupPage.isVisible('#view-dashboard');
  console.log('📊 Dashboard visible:', dashboardVisible);

  // Click Import Design System
  console.log('🎨 Clicking Import Design System...');
  await popupPage.click('#import-design-btn');
  await popupPage.waitForTimeout(1000);

  // Wait for import to complete (up to 60 seconds)
  console.log('⏳ Waiting for design system import...');
  for (let i = 0; i < 30; i++) {
    await popupPage.waitForTimeout(2000);

    const status = await popupPage.$eval('#design-import-status', el => el.textContent).catch(() => '');
    console.log(`  [${i*2}s] Status: ${status}`);

    if (status.includes('imported')) {
      console.log('✅ Design system imported!');
      break;
    }
    if (status.includes('Error')) {
      console.log('❌ Error:', status);
      break;
    }
  }

  // Check if tokens are displayed
  await popupPage.waitForTimeout(500);
  await popupPage.screenshot({ path: '/tmp/design-import-result.png' });
  console.log('📸 Screenshot: /tmp/design-import-result.png');

  const colorsHtml = await popupPage.$eval('#token-colors', el => el.innerHTML).catch(() => '');
  const fontsHtml = await popupPage.$eval('#token-fonts', el => el.innerHTML).catch(() => '');

  console.log('\n📊 Results:');
  console.log('  Colors displayed:', colorsHtml.length > 0 ? '✅ Yes' : '❌ No');
  console.log('  Fonts displayed:', fontsHtml.length > 0 ? '✅ Yes' : '❌ No');

  if (colorsHtml.length > 0) {
    const colorCount = (colorsHtml.match(/token-item/g) || []).length;
    console.log(`  Color tokens: ${colorCount}`);
  }
  if (fontsHtml.length > 0) {
    const fontCount = (fontsHtml.match(/token-item/g) || []).length;
    console.log(`  Font tokens: ${fontCount}`);
  }

  // Check spinner is hidden
  const spinnerVisible = await popupPage.isVisible('.spinner');
  console.log('  Spinner hidden:', !spinnerVisible ? '✅ Yes' : '❌ No');

  console.log('\n✅ Test complete!');

  await popupPage.waitForTimeout(5000);
  await context.close();
}

testDesignImport().catch(e => console.error('❌ Error:', e));
