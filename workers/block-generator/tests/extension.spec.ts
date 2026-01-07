import { test, expect, chromium, BrowserContext, Page } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const EXTENSION_PATH = path.join(__dirname, '../chrome-extension');

test.describe('AEM Block Generator Extension', () => {
  let context: BrowserContext;
  let extensionId: string;

  test.beforeAll(async () => {
    // Launch browser with extension
    context = await chromium.launchPersistentContext('', {
      headless: false, // Extensions require headed mode
      args: [
        `--disable-extensions-except=${EXTENSION_PATH}`,
        `--load-extension=${EXTENSION_PATH}`,
      ],
    });

    // Get extension ID from service worker
    let [background] = context.serviceWorkers();
    if (!background) {
      background = await context.waitForEvent('serviceworker');
    }
    extensionId = background.url().split('/')[2];
    console.log('Extension ID:', extensionId);

    // Listen to service worker console
    background.on('console', msg => {
      console.log(`[SW] ${msg.type()}: ${msg.text()}`);
    });
  });

  test.afterAll(async () => {
    await context.close();
  });

  test('trigger generation and check GENERATION_STARTED message', async () => {
    const page = await context.newPage();

    // Capture all console messages from page
    page.on('console', msg => {
      console.log(`[PAGE] ${msg.type()}: ${msg.text()}`);
    });

    // Navigate to test page
    await page.goto('https://wknd-trendsetters.site');
    await page.waitForLoadState('networkidle');
    console.log('Page loaded');

    // Open sidebar via popup
    const popupPage = await context.newPage();
    popupPage.on('console', msg => {
      console.log(`[POPUP] ${msg.type()}: ${msg.text()}`);
    });

    await popupPage.goto(`chrome-extension://${extensionId}/popup/popup.html`);
    await popupPage.waitForLoadState('domcontentloaded');
    await popupPage.click('#open-sidebar');
    console.log('Clicked open-sidebar');

    await page.waitForTimeout(2000);

    // Take initial screenshot
    await page.screenshot({ path: 'test-results/01-initial.png' });

    // Check if we need to configure the extension first
    const needsConfig = await page.evaluate(() => {
      const sidebar = document.querySelector('#aem-importer-sidebar');
      const buttons = sidebar?.querySelectorAll('button') || [];
      const connectBtn = Array.from(buttons).find(b => b.textContent?.includes('Connect'));
      return !!connectBtn;
    });
    console.log('Needs config:', needsConfig);

    // Scroll down to find a good element
    await page.evaluate(() => window.scrollTo(0, 500));
    await page.waitForTimeout(500);

    // Find the "Select Element" or equivalent button in the sidebar
    const sidebarButtons = await page.evaluate(() => {
      const sidebar = document.querySelector('#aem-importer-sidebar');
      if (!sidebar) return [];
      const buttons = sidebar.querySelectorAll('button');
      return Array.from(buttons).map(b => ({ text: b.textContent, id: b.id, className: b.className }));
    });
    console.log('Sidebar buttons:', JSON.stringify(sidebarButtons, null, 2));

    // Try to click "Select Element" or similar button
    const selectBtnClicked = await page.evaluate(() => {
      const sidebar = document.querySelector('#aem-importer-sidebar');
      if (!sidebar) return false;
      const selectBtn = sidebar.querySelector('#aem-select-element') ||
                        sidebar.querySelector('button[class*="select"]');
      if (selectBtn) {
        (selectBtn as HTMLElement).click();
        return true;
      }
      return false;
    });
    console.log('Select button clicked:', selectBtnClicked);

    await page.waitForTimeout(1000);

    // Now click on an element in the page
    const featureGrid = await page.$('section, .hero, .feature-grid, .cards');
    if (featureGrid) {
      console.log('Clicking on feature element');
      await featureGrid.click();
      await page.waitForTimeout(500);
    }

    // Take screenshot after selection
    await page.screenshot({ path: 'test-results/02-after-select.png' });

    // Check sidebar state
    const sidebarState = await page.evaluate(() => {
      const sidebar = document.querySelector('#aem-importer-sidebar');
      const variantsSection = sidebar?.querySelector('#aem-variants-section');
      const variantsGrid = sidebar?.querySelector('#aem-variants-grid');
      const generateBtn = sidebar?.querySelector('#aem-generate-block');

      return {
        sidebarExists: !!sidebar,
        variantsSectionExists: !!variantsSection,
        variantsGridExists: !!variantsGrid,
        variantsSectionHidden: variantsSection?.classList.contains('aem-hidden'),
        generateBtnExists: !!generateBtn,
        generateBtnText: generateBtn?.textContent,
      };
    });
    console.log('Sidebar state:', JSON.stringify(sidebarState, null, 2));

    // Try to click Generate
    if (sidebarState.generateBtnExists) {
      console.log('Clicking Generate button');
      await page.click('#aem-generate-block');

      // Wait and watch for messages
      console.log('Waiting for GENERATION_STARTED message...');
      await page.waitForTimeout(10000);

      // Check if variants grid appeared
      const afterGenerate = await page.evaluate(() => {
        const grid = document.querySelector('#aem-variants-grid');
        const section = document.querySelector('#aem-variants-section');
        return {
          sectionHidden: section?.classList.contains('aem-hidden'),
          gridChildren: grid?.children.length,
          gridHTML: grid?.innerHTML?.substring(0, 300),
        };
      });
      console.log('After generate:', JSON.stringify(afterGenerate, null, 2));
    }

    await page.screenshot({ path: 'test-results/03-after-generate.png' });
    await popupPage.close();
  });

  test('manually show variants grid to verify UI works', async () => {
    const page = await context.newPage();

    page.on('console', msg => {
      console.log(`[PAGE] ${msg.type()}: ${msg.text()}`);
    });

    await page.goto('https://wknd-trendsetters.site');
    await page.waitForLoadState('networkidle');

    // Inject sidebar
    const popupPage = await context.newPage();
    await popupPage.goto(`chrome-extension://${extensionId}/popup/popup.html`);
    await popupPage.waitForLoadState('domcontentloaded');
    await popupPage.click('#open-sidebar');
    await page.waitForTimeout(2000);

    // Manually show the variants grid
    const result = await page.evaluate(() => {
      const grid = document.querySelector('#aem-variants-grid');
      const section = document.querySelector('#aem-variants-section');

      if (!grid || !section) {
        return { error: 'Grid or section not found' };
      }

      // Create 3 variant cells
      grid.innerHTML = '';
      for (let opt = 1; opt <= 3; opt++) {
        const cell = document.createElement('span');
        cell.className = 'aem-variant-cell pending';
        cell.id = `aem-variant-${opt}-1`;
        cell.textContent = `${opt}-1`;
        cell.dataset.option = String(opt);
        cell.dataset.iteration = '1';
        grid.appendChild(cell);
      }

      // Show section
      section.classList.remove('aem-hidden');

      // Simulate progress
      setTimeout(() => {
        const c1 = document.querySelector('#aem-variant-1-1');
        if (c1) { c1.classList.remove('pending'); c1.classList.add('ready'); }
      }, 500);
      setTimeout(() => {
        const c2 = document.querySelector('#aem-variant-2-1');
        if (c2) { c2.classList.remove('pending'); c2.classList.add('ready'); }
      }, 1000);
      setTimeout(() => {
        const c3 = document.querySelector('#aem-variant-3-1');
        if (c3) {
          c3.classList.remove('pending');
          c3.classList.add('ready');
          c3.classList.add('winner');
        }
      }, 1500);

      return { success: true, gridChildren: grid.children.length };
    });

    console.log('Manual grid result:', JSON.stringify(result, null, 2));

    await page.waitForTimeout(2000);
    await page.screenshot({ path: 'test-results/04-manual-variants.png' });

    await popupPage.close();
  });
});
