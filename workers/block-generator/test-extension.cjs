/**
 * Playwright test for Chrome Extension
 * Tests the block generation flow through the service worker
 */

const { chromium } = require('playwright');
const path = require('path');

const EXTENSION_PATH = path.join(__dirname, 'chrome-extension');
const WORKER_URL = 'https://eds-block-generator.paolo-moz.workers.dev';

async function testExtension() {
  console.log('Starting extension test...');
  console.log('Extension path:', EXTENSION_PATH);

  // Launch browser with extension
  const browser = await chromium.launchPersistentContext('', {
    headless: false, // Extensions require headed mode
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

    // Get service worker
    let serviceWorker;
    const workers = browser.serviceWorkers();
    console.log('Service workers found:', workers.length);

    for (const worker of workers) {
      const url = worker.url();
      console.log('Worker URL:', url);
      if (url.includes('chrome-extension://')) {
        serviceWorker = worker;
      }
    }

    if (!serviceWorker) {
      throw new Error('Extension service worker not found');
    }

    // Listen to service worker console
    serviceWorker.on('console', msg => {
      console.log(`[SW ${msg.type()}]`, msg.text());
    });

    // Clear chrome storage to ensure we use production URL
    console.log('\n=== Clearing chrome storage to reset config ===');
    const clearResult = await serviceWorker.evaluate(async () => {
      try {
        // Get current config before clearing
        const before = await chrome.storage.local.get('aem_importer_config');
        console.log('Config before clear:', JSON.stringify(before));

        // Clear the config
        await chrome.storage.local.remove('aem_importer_config');

        // Verify it's cleared
        const after = await chrome.storage.local.get('aem_importer_config');
        console.log('Config after clear:', JSON.stringify(after));

        return { before, after, success: true };
      } catch (err) {
        return { error: err.message };
      }
    });
    console.log('Clear result:', JSON.stringify(clearResult, null, 2));

    // Verify the ApiClient now uses production URL
    console.log('\n=== Verifying ApiClient uses production URL ===');
    const workerUrlCheck = await serviceWorker.evaluate(async () => {
      try {
        // StateManager and ApiClient should be available in service worker
        const config = await StateManager.getConfig();
        const workerUrl = config.workerUrl || ApiClient.DEFAULT_WORKER_URL;
        return {
          configWorkerUrl: config.workerUrl,
          defaultWorkerUrl: ApiClient.DEFAULT_WORKER_URL,
          effectiveWorkerUrl: workerUrl,
        };
      } catch (err) {
        return { error: err.message };
      }
    });
    console.log('Worker URL check:', JSON.stringify(workerUrlCheck, null, 2));

    if (workerUrlCheck.effectiveWorkerUrl !== WORKER_URL) {
      console.error(`❌ ERROR: Expected production URL ${WORKER_URL} but got ${workerUrlCheck.effectiveWorkerUrl}`);
    } else {
      console.log(`✅ Confirmed: Extension will use production URL: ${workerUrlCheck.effectiveWorkerUrl}`);
    }

    // Navigate to test page
    const page = await browser.newPage();

    // Listen to page console
    page.on('console', msg => {
      console.log(`[PAGE ${msg.type()}]`, msg.text());
    });

    console.log('\nNavigating to example.com...');
    await page.goto('https://example.com', { waitUntil: 'networkidle' });

    // Inject the content scripts manually
    console.log('\nInjecting content scripts...');
    await page.addScriptTag({ path: path.join(EXTENSION_PATH, 'content/xpath-generator.js') });
    await page.addScriptTag({ path: path.join(EXTENSION_PATH, 'content/selector.js') });
    await new Promise(r => setTimeout(r, 500));

    // Get element info
    const elementInfo = await page.evaluate(() => {
      // Try to find the main content div
      const element = document.querySelector('body > div');
      console.log('Selected element:', element?.tagName, element?.outerHTML?.substring(0, 100));

      if (!element) {
        console.log('No element found');
        return { error: 'No element found' };
      }

      if (!window.XPathGenerator) {
        console.log('XPathGenerator not available');
        return { error: 'XPathGenerator not available' };
      }

      const info = window.XPathGenerator.getElementInfo(element);
      console.log('XPathGenerator result:', JSON.stringify(info).substring(0, 200));
      return info;
    });

    console.log('\nElement info extracted:');
    console.log('  xpath:', elementInfo?.xpath);
    console.log('  htmlLength:', elementInfo?.html?.length);
    console.log('  bounds:', JSON.stringify(elementInfo?.bounds));

    // Capture screenshot
    console.log('\nCapturing screenshot...');
    const screenshotBuffer = await page.screenshot({ type: 'png' });
    console.log('Screenshot size:', screenshotBuffer.length, 'bytes');

    // Test API directly from page (bypassing extension)
    console.log('\nTesting API directly from page...');

    const apiResult = await page.evaluate(async ({ workerUrl, html, xpath, screenshotBase64 }) => {
      try {
        // Convert base64 to blob
        const binaryString = atob(screenshotBase64);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          bytes[i] = binaryString.charCodeAt(i);
        }
        const blob = new Blob([bytes], { type: 'image/png' });

        console.log('Sending request to:', workerUrl + '/block-generate');
        console.log('  screenshot blob size:', blob.size);
        console.log('  html length:', html?.length);
        console.log('  xpath:', xpath);

        const formData = new FormData();
        formData.append('url', window.location.href);
        formData.append('screenshot', blob, 'element.png');
        if (xpath) formData.append('xpath', xpath);
        if (html) formData.append('html', html);

        const response = await fetch(workerUrl + '/block-generate', {
          method: 'POST',
          body: formData,
        });

        console.log('Response status:', response.status);

        const result = await response.json();
        return { status: response.status, result };
      } catch (err) {
        return { error: err.message, stack: err.stack };
      }
    }, {
      workerUrl: WORKER_URL,
      html: elementInfo?.html,
      xpath: elementInfo?.xpath,
      screenshotBase64: screenshotBuffer.toString('base64'),
    });

    console.log('\nAPI result:');
    console.log(JSON.stringify(apiResult, null, 2));

    if (apiResult.status === 200 && apiResult.result?.success) {
      console.log('\n✅ Block generation successful!');
      console.log('  Block name:', apiResult.result.blockName);
      console.log('  HTML length:', apiResult.result.html?.length);
      console.log('  CSS length:', apiResult.result.css?.length);
      console.log('  JS length:', apiResult.result.js?.length);
    } else {
      console.log('\n❌ Block generation failed');
    }

  } catch (error) {
    console.error('Test failed:', error);
  } finally {
    console.log('\nClosing browser...');
    await browser.close();
  }
}

testExtension().catch(console.error);
