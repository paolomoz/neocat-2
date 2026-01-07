/**
 * Playwright test for parallel block generation Chrome extension
 *
 * This test launches Chrome with the extension loaded and tests the
 * parallel block generation feature.
 */
import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionPath = path.join(__dirname, 'workers/block-generator/chrome-extension');

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  console.log('🚀 Launching Chrome with extension...');
  console.log('   Extension path:', extensionPath);

  // Create a temp user data dir for persistent context
  const userDataDir = path.join(__dirname, '.playwright-user-data');
  if (!fs.existsSync(userDataDir)) {
    fs.mkdirSync(userDataDir, { recursive: true });
  }

  // Launch Chrome with extension
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      '--no-first-run',
      '--disable-blink-features=AutomationControlled',
    ],
    viewport: { width: 1600, height: 1000 },
  });

  // Get background service worker page for extension
  let extensionId = null;
  const serviceWorkers = context.serviceWorkers();
  for (const sw of serviceWorkers) {
    if (sw.url().includes('chrome-extension://')) {
      extensionId = sw.url().split('/')[2];
      console.log('   Extension ID:', extensionId);
      break;
    }
  }

  // Wait for extension to load
  await sleep(2000);

  // Try to get extension ID from service workers again
  if (!extensionId) {
    const workers = context.serviceWorkers();
    for (const sw of workers) {
      if (sw.url().includes('chrome-extension://')) {
        extensionId = sw.url().split('/')[2];
        console.log('   Extension ID (retry):', extensionId);
        break;
      }
    }
  }

  const page = await context.newPage();

  try {
    // Navigate to test page
    console.log('\n📄 Navigating to https://www.avionrewards.com/redeem.html');
    await page.goto('https://www.avionrewards.com/redeem.html', {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });
    // Wait for page to settle
    await sleep(5000);

    console.log('\n🔧 Opening extension popup to inject sidebar...');

    // Open the extension popup in a new page
    if (extensionId) {
      const popupPage = await context.newPage();
      await popupPage.goto(`chrome-extension://${extensionId}/popup/popup.html`);
      await sleep(500);

      // Click "Open Sidebar" button in popup
      const openSidebarBtn = await popupPage.$('#open-sidebar-btn');
      if (openSidebarBtn) {
        await openSidebarBtn.click();
        console.log('   Clicked "Open Sidebar" in popup');
      }
      await popupPage.close();
    }

    await sleep(2000);

    // Check if sidebar is injected
    let sidebarVisible = await page.evaluate(() => {
      const sidebar = document.querySelector('#aem-importer-sidebar');
      return sidebar && sidebar.classList.contains('aem-visible');
    });

    // If sidebar not visible via extension, try using extension background page
    if (!sidebarVisible && extensionId) {
      console.log('   Trying to inject via extension background...');

      // Use Chrome DevTools Protocol to send message to extension
      const client = await page.context().newCDPSession(page);

      // Execute in extension context - trigger sidebar injection
      try {
        await client.send('Runtime.evaluate', {
          expression: `
            chrome.scripting.executeScript({
              target: { tabId: ${await page.evaluate(() => window.__tabId || 0)} },
              files: ['content/sidebar.css', 'content/sidebar.js']
            });
          `,
          contextId: 1
        });
      } catch (e) {
        console.log('   CDP approach failed, falling back to direct injection...');
      }

      // Fallback: inject directly with real extension communication
      await page.addStyleTag({ path: path.join(extensionPath, 'content/sidebar.css') });
      await page.addScriptTag({ path: path.join(extensionPath, 'content/sidebar.js') });
      await sleep(1000);

      // Show sidebar
      await page.evaluate(() => {
        if (window.__aemBlockImporterSidebar) {
          window.__aemBlockImporterSidebar.show();
        }
      });
      await sleep(1000);
    }

    // Check if sidebar is visible now
    sidebarVisible = await page.evaluate(() => {
      const sidebar = document.querySelector('#aem-importer-sidebar');
      return sidebar && sidebar.classList.contains('aem-visible');
    });

    if (!sidebarVisible) {
      console.log('⚠️  Sidebar not visible, trying again...');
      await page.evaluate(() => {
        if (window.__aemBlockImporterSidebar) {
          window.__aemBlockImporterSidebar.show();
        }
      });
      await sleep(1000);
    }

    console.log('✅ Sidebar visible:', sidebarVisible);

    // Take screenshot
    await page.screenshot({ path: 'test-screenshot-1-sidebar-open.png' });
    console.log('📸 Screenshot saved: test-screenshot-1-sidebar-open.png');

    // Configure the GitHub repo
    console.log('\n⚙️  Configuring GitHub repo...');
    const repoInput = await page.$('#aem-github-repo');
    if (repoInput) {
      await repoInput.fill('paolomoz/neocat-virginatlanticcargo');
      await sleep(500);

      // Click Connect button
      const connectBtn = await page.$('#aem-save-config');
      if (connectBtn) {
        await connectBtn.click();
        console.log('   Configured repo: paolomoz/neocat-virginatlanticcargo');
        await sleep(2000);
      }
    } else {
      console.log('   Repo input not found - may already be configured');
    }

    await page.screenshot({ path: 'test-screenshot-2-configured.png' });
    console.log('📸 Screenshot saved: test-screenshot-2-configured.png');

    // Click "Select Blocks" button
    console.log('\n🎯 Clicking "Select Blocks" button...');
    const selectBlocksBtn = await page.$('#aem-select-blocks-btn');
    if (selectBlocksBtn) {
      await selectBlocksBtn.click();
      await sleep(500);
    } else {
      console.log('⚠️  Select Blocks button not found, checking if we need setup first...');
      // May need to configure repo first - skip for now
    }

    await page.screenshot({ path: 'test-screenshot-3-multi-select-mode.png' });
    console.log('📸 Screenshot saved: test-screenshot-3-multi-select-mode.png');

    // Find sections to click on the page
    console.log('\n🖱️  Selecting elements on page...');

    // Get page sections to click
    const sections = await page.evaluate(() => {
      const elements = [];
      // Look for major sections
      const selectors = [
        'section',
        '[class*="hero"]',
        '[class*="card"]',
        'article',
        '.container > div',
        'main > div',
      ];

      for (const selector of selectors) {
        const found = document.querySelectorAll(selector);
        for (const el of found) {
          if (el.offsetHeight > 100 && el.offsetWidth > 200) {
            const rect = el.getBoundingClientRect();
            if (rect.top > 0 && rect.top < window.innerHeight) {
              elements.push({
                x: rect.left + rect.width / 2,
                y: rect.top + rect.height / 2,
                tag: el.tagName,
                class: el.className?.substring?.(0, 50) || '',
              });
            }
          }
        }
        if (elements.length >= 3) break;
      }
      return elements.slice(0, 3);
    });

    console.log(`   Found ${sections.length} sections to click`);

    // Click on each section
    for (let i = 0; i < sections.length; i++) {
      const section = sections[i];
      console.log(`   Clicking section ${i + 1}: ${section.tag}.${section.class} at (${Math.round(section.x)}, ${Math.round(section.y)})`);

      // Move mouse and click
      await page.mouse.move(section.x, section.y);
      await sleep(300);
      await page.mouse.click(section.x, section.y);
      await sleep(500);
    }

    await page.screenshot({ path: 'test-screenshot-4-elements-selected.png' });
    console.log('📸 Screenshot saved: test-screenshot-4-elements-selected.png');

    // Wait for generations to complete
    console.log('\n⏳ Waiting for block generations (this may take a while)...');

    // Wait and check progress periodically
    for (let i = 0; i < 60; i++) {
      await sleep(5000);

      const status = await page.evaluate(() => {
        const countEl = document.querySelector('#aem-multi-count');
        const statusEl = document.querySelector('#aem-multi-status');
        const accordionEl = document.querySelector('#aem-multi-accordion');

        // Count items by status
        const items = accordionEl?.querySelectorAll('.aem-accordion-item') || [];
        let pending = 0, active = 0, complete = 0, error = 0;

        items.forEach(item => {
          if (item.classList.contains('aem-status-pending')) pending++;
          if (item.classList.contains('aem-status-active')) active++;
          if (item.classList.contains('aem-status-complete')) complete++;
          if (item.classList.contains('aem-status-error')) error++;
        });

        return {
          total: items.length,
          pending,
          active,
          complete,
          error,
          statusText: statusEl?.textContent || '',
        };
      });

      console.log(`   Progress: ${status.complete}/${status.total} complete, ${status.active} active, ${status.pending} pending, ${status.error} errors`);

      // Check if all done
      if (status.total > 0 && status.active === 0 && status.pending === 0) {
        console.log('   ✅ All generations complete!');
        break;
      }

      // Take progress screenshot every 30 seconds
      if (i % 6 === 5) {
        await page.screenshot({ path: `test-screenshot-progress-${i}.png` });
      }
    }

    await page.screenshot({ path: 'test-screenshot-5-generations-complete.png' });
    console.log('📸 Screenshot saved: test-screenshot-5-generations-complete.png');

    // Get preview URLs
    console.log('\n🔗 Getting preview URLs...');
    const previewUrls = await page.evaluate(() => {
      const links = document.querySelectorAll('.aem-accordion-preview-url');
      return Array.from(links).map(link => link.href).filter(href => href && href !== '#');
    });

    console.log(`   Found ${previewUrls.length} preview URLs:`);
    previewUrls.forEach((url, i) => console.log(`   ${i + 1}. ${url}`));

    // Open preview URLs in new tabs
    if (previewUrls.length > 0) {
      console.log('\n🌐 Opening preview pages...');

      for (const url of previewUrls) {
        console.log(`   Opening: ${url}`);
        const previewPage = await context.newPage();
        await previewPage.goto(url, { waitUntil: 'networkidle', timeout: 30000 }).catch(e => {
          console.log(`   ⚠️ Failed to load: ${e.message}`);
        });
        await sleep(2000);

        // Screenshot the preview
        const filename = `test-preview-${url.split('/').pop() || 'page'}.png`;
        await previewPage.screenshot({ path: filename });
        console.log(`   📸 Screenshot saved: ${filename}`);
      }
    }

    console.log('\n✅ Test complete! Browser will stay open for inspection.');
    console.log('   Press Ctrl+C to close.');

    // Keep browser open for manual inspection
    await sleep(300000); // 5 minutes

  } catch (error) {
    console.error('\n❌ Error:', error.message);
    await page.screenshot({ path: 'test-screenshot-error.png' });
    console.log('📸 Error screenshot saved: test-screenshot-error.png');
  } finally {
    await context.close();
  }
}

main().catch(console.error);
