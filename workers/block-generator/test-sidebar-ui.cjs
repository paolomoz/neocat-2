/**
 * Playwright test for Chrome Extension Sidebar UI
 * Verifies the simplified UI has only "Select Block" button
 */

const { chromium } = require('playwright');
const path = require('path');

const EXTENSION_PATH = path.join(__dirname, 'chrome-extension');

async function testSidebarUI() {
  console.log('Starting sidebar UI test...');
  console.log('Extension path:', EXTENSION_PATH);

  // Launch browser with extension
  const browser = await chromium.launchPersistentContext('', {
    headless: false,
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      '--no-sandbox',
    ],
    viewport: { width: 1440, height: 900 },
  });

  try {
    // Wait for service worker to be ready
    await new Promise(r => setTimeout(r, 2000));

    // Navigate to a test page
    const page = await browser.newPage();
    console.log('\nNavigating to example.com...');
    await page.goto('https://example.com', { waitUntil: 'networkidle' });

    // Mock Chrome API before injecting scripts
    console.log('\nMocking Chrome API...');
    await page.evaluate(() => {
      const storage = {
        'aem_importer_config': {
          githubRepo: 'test/repo',
          daOrg: 'test',
          daSite: 'repo',
          updatedAt: Date.now()
        }
      };
      window.chrome = {
        storage: {
          local: {
            get: async (keys) => {
              if (typeof keys === 'string') {
                return { [keys]: storage[keys] };
              }
              const result = {};
              for (const key of keys) {
                result[key] = storage[key];
              }
              return result;
            },
            set: async (items) => {
              Object.assign(storage, items);
            },
            remove: async (keys) => {
              if (typeof keys === 'string') {
                delete storage[keys];
              } else {
                for (const key of keys) {
                  delete storage[key];
                }
              }
            }
          }
        },
        runtime: {
          sendMessage: async (message) => {
            console.log('Mock sendMessage:', message);
            if (message.type === 'GET_BLOCKS') {
              return { blocks: [] };
            }
            return { success: true };
          },
          onMessage: {
            addListener: () => {}
          }
        }
      };
    });

    // Inject the sidebar script and CSS
    console.log('\nInjecting sidebar...');
    await page.addStyleTag({ path: path.join(EXTENSION_PATH, 'content/sidebar.css') });
    await page.addScriptTag({ path: path.join(EXTENSION_PATH, 'content/sidebar.js') });
    await new Promise(r => setTimeout(r, 1000));

    // Open the sidebar
    console.log('\nOpening sidebar...');
    await page.evaluate(() => {
      if (window.__aemBlockImporterSidebar) {
        window.__aemBlockImporterSidebar.show();
      }
    });
    await new Promise(r => setTimeout(r, 500));

    // The sidebar will show the setup view initially - we need to check the dashboard HTML
    // Since we can't use chrome.storage in page context, verify the dashboard template directly
    console.log('\nChecking dashboard template in sidebar HTML...');

    // Verify UI elements
    console.log('\nVerifying sidebar UI...');
    const uiCheck = await page.evaluate(() => {
      const sidebar = document.querySelector('#aem-importer-sidebar');
      if (!sidebar) return { error: 'Sidebar not found' };

      const results = {
        sidebarVisible: sidebar.classList.contains('aem-visible'),
        selectBlockBtn: !!sidebar.querySelector('#aem-select-block-btn'),
        importDesignBtn: !!sidebar.querySelector('#aem-import-design-btn'),
        importPageBtn: !!sidebar.querySelector('#aem-import-page-btn'),
        blockLibrary: !!sidebar.querySelector('.aem-block-library'),
        refreshLibraryBtn: !!sidebar.querySelector('#aem-refresh-library'),
      };

      // Get text of the select block button
      const selectBtn = sidebar.querySelector('#aem-select-block-btn');
      if (selectBtn) {
        results.selectBlockText = selectBtn.textContent.trim();
      }

      // Count action buttons
      const actionBtns = sidebar.querySelectorAll('.aem-dashboard-actions .aem-action-btn');
      results.actionButtonCount = actionBtns.length;

      return results;
    });

    console.log('\nUI Check Results:');
    console.log(JSON.stringify(uiCheck, null, 2));

    // Validate expectations
    let passed = true;

    if (!uiCheck.selectBlockBtn) {
      console.log('❌ FAIL: Select Block button not found');
      passed = false;
    } else {
      console.log('✅ PASS: Select Block button found');
    }

    if (uiCheck.importDesignBtn) {
      console.log('❌ FAIL: Import Design System button should be removed');
      passed = false;
    } else {
      console.log('✅ PASS: Import Design System button removed');
    }

    if (uiCheck.importPageBtn) {
      console.log('❌ FAIL: Import This Page button should be removed');
      passed = false;
    } else {
      console.log('✅ PASS: Import This Page button removed');
    }

    if (uiCheck.blockLibrary) {
      console.log('❌ FAIL: Block Library section should be removed');
      passed = false;
    } else {
      console.log('✅ PASS: Block Library section removed');
    }

    if (uiCheck.actionButtonCount !== 1) {
      console.log(`❌ FAIL: Expected 1 action button, found ${uiCheck.actionButtonCount}`);
      passed = false;
    } else {
      console.log('✅ PASS: Only 1 action button in dashboard');
    }

    // Take screenshot for visual verification
    console.log('\nTaking screenshot...');
    await page.screenshot({ path: 'sidebar-ui-test.png', fullPage: false });
    console.log('Screenshot saved to sidebar-ui-test.png');

    if (passed) {
      console.log('\n✅ All UI tests PASSED!');
    } else {
      console.log('\n❌ Some UI tests FAILED');
      process.exitCode = 1;
    }

  } catch (error) {
    console.error('Test failed:', error);
    process.exitCode = 1;
  } finally {
    console.log('\nClosing browser...');
    await browser.close();
  }
}

testSidebarUI().catch(console.error);
