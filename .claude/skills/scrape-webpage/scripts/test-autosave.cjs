const { chromium } = require('playwright');

const extensionPath = '/Users/paolo/excat/neocat-2/workers/block-generator/chrome-extension';
const userDataDir = `/tmp/chrome-ext-autosave-${Date.now()}`;

async function testSimplifiedConfig() {
  console.log('🚀 Launching Chrome with extension...');
  console.log('📁 User data dir:', userDataDir);

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: [
      '--disable-extensions-except=' + extensionPath,
      '--load-extension=' + extensionPath,
    ],
    viewport: { width: 1200, height: 800 },
  });

  const page = context.pages()[0] || await context.newPage();

  // Wait for extension to load
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

  // Navigate to a test page first
  await page.goto('https://example.com');
  await page.waitForLoadState('networkidle');

  // Open popup
  console.log('\n📦 Opening extension popup...');
  const popupPage = await context.newPage();
  await popupPage.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  await popupPage.waitForTimeout(500);

  // Verify setup view is shown
  const setupVisible = await popupPage.isVisible('#view-setup');
  console.log('📋 Setup view visible:', setupVisible);

  // Take screenshot of simplified setup
  await popupPage.screenshot({ path: '/tmp/extension-simplified-setup.png' });
  console.log('📸 Setup screenshot: /tmp/extension-simplified-setup.png');

  // Test 1: Test with owner/repo format
  console.log('\n📝 Test 1: Testing owner/repo format...');
  await popupPage.fill('#github-repo', 'paolomoz/neocat-virginatlanticcargo');
  await popupPage.waitForTimeout(300);

  // Test 2: Test auto-save
  console.log('\n💾 Testing auto-save...');
  const draft = await popupPage.evaluate(() => {
    return new Promise(resolve => {
      chrome.storage.local.get('aem_importer_draft', result => {
        resolve(result['aem_importer_draft']);
      });
    });
  });
  console.log('  Draft saved:', JSON.stringify(draft));

  // Close and reopen to test restore
  await popupPage.close();
  await page.waitForTimeout(500);

  const popupPage2 = await context.newPage();
  await popupPage2.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  await popupPage2.waitForTimeout(500);

  const restoredValue = await popupPage2.inputValue('#github-repo');
  console.log('  Restored value:', restoredValue);
  console.log('  Auto-save:', restoredValue === 'paolomoz/neocat-virginatlanticcargo' ? '✅ PASS' : '❌ FAIL');

  // Test 3: Test full GitHub URL format
  console.log('\n📝 Test 2: Testing full GitHub URL format...');
  await popupPage2.fill('#github-repo', 'https://github.com/paolomoz/neocat-virginatlanticcargo');
  await popupPage2.waitForTimeout(300);

  // Click Connect button
  console.log('\n🔗 Clicking Connect button...');
  await popupPage2.click('#save-config-btn');
  await popupPage2.waitForTimeout(1000);

  // Check if we moved to dashboard
  const dashboardVisible = await popupPage2.isVisible('#view-dashboard');
  console.log('📊 Dashboard visible:', dashboardVisible);

  if (dashboardVisible) {
    // Take screenshot of dashboard
    await popupPage2.screenshot({ path: '/tmp/extension-dashboard.png' });
    console.log('📸 Dashboard screenshot: /tmp/extension-dashboard.png');

    // Verify config was saved correctly
    const savedConfig = await popupPage2.evaluate(() => {
      return new Promise(resolve => {
        chrome.storage.local.get('aem_importer_config', result => {
          resolve(result['aem_importer_config']);
        });
      });
    });
    console.log('\n📦 Saved config:');
    console.log('  githubRepo:', savedConfig.githubRepo);
    console.log('  daOrg:', savedConfig.daOrg);
    console.log('  daSite:', savedConfig.daSite);
    console.log('  (no token - backend uses .env)');

    // Verify DA info was derived correctly
    const daCorrect = savedConfig.daOrg === 'paolomoz' && savedConfig.daSite === 'neocat-virginatlanticcargo';
    console.log('\n  DA derivation:', daCorrect ? '✅ PASS' : '❌ FAIL');
  }

  // Final result
  console.log('\n' + '='.repeat(50));
  console.log('✅ SIMPLIFIED CONFIG TEST COMPLETE');
  console.log('='.repeat(50));

  // Clean up
  await popupPage2.close();
  await context.close();
}

testSimplifiedConfig().catch(e => console.error('❌ Error:', e));
