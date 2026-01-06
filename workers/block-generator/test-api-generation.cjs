/**
 * Test block generation API directly
 * Tests that the generated JS matches the HTML structure
 */

const { chromium } = require('playwright');

const WORKER_URL = 'https://eds-block-generator.paolo-moz.workers.dev';
const TEST_URL = 'https://www.virginatlanticcargo.com/gb/en.html';

async function testBlockGeneration() {
  console.log('Starting block generation API test...\n');

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  try {
    console.log('1. Loading page:', TEST_URL);
    await page.goto(TEST_URL, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(2000);

    // Find the product cards section (the 3-card grid)
    console.log('2. Finding product cards section...');

    const elementData = await page.evaluate(() => {
      // Look for the section with the product cards (Book online, Track cargo, etc.)
      const cards = document.querySelectorAll('a[href*="book"], a[href*="track"], a[href*="contact"]');
      if (cards.length > 0) {
        // Find their common parent
        let parent = cards[0].closest('section') || cards[0].closest('div');
        while (parent && parent.querySelectorAll('a').length < 3) {
          parent = parent.parentElement;
        }
        if (parent) {
          const rect = parent.getBoundingClientRect();
          return {
            html: parent.outerHTML.substring(0, 5000), // Limit size
            xpath: '//section[contains(@class, "quick")]',
            bounds: {
              x: rect.x,
              y: rect.y,
              width: rect.width,
              height: rect.height,
            }
          };
        }
      }

      // Fallback: find any card-like grid
      const grids = document.querySelectorAll('[class*="card"], [class*="grid"], [class*="product"]');
      for (const grid of grids) {
        const items = grid.querySelectorAll('a, img');
        if (items.length >= 3) {
          const rect = grid.getBoundingClientRect();
          if (rect.height > 100) {
            return {
              html: grid.outerHTML.substring(0, 5000),
              xpath: '//*[contains(@class, "card")]',
              bounds: {
                x: rect.x,
                y: rect.y,
                width: rect.width,
                height: rect.height,
              }
            };
          }
        }
      }

      return null;
    });

    if (!elementData) {
      throw new Error('Could not find product cards element');
    }

    console.log('   Found element, HTML length:', elementData.html.length);
    console.log('   Bounds:', JSON.stringify(elementData.bounds));

    // Take screenshot
    console.log('3. Capturing screenshot...');
    const screenshot = await page.screenshot({
      type: 'png',
      clip: elementData.bounds.height > 0 ? {
        x: Math.max(0, elementData.bounds.x),
        y: Math.max(0, elementData.bounds.y),
        width: Math.min(elementData.bounds.width, 1440),
        height: Math.min(elementData.bounds.height, 900),
      } : undefined
    });
    console.log('   Screenshot size:', screenshot.length, 'bytes');

    // Call the API
    console.log('4. Calling block-generate API...');
    const FormData = (await import('form-data')).default;
    const fetch = (await import('node-fetch')).default;

    const formData = new FormData();
    formData.append('url', TEST_URL);
    formData.append('screenshot', screenshot, { filename: 'element.png', contentType: 'image/png' });
    formData.append('html', elementData.html);
    formData.append('xpath', elementData.xpath);

    const response = await fetch(`${WORKER_URL}/block-generate`, {
      method: 'POST',
      body: formData,
    });

    console.log('   Response status:', response.status);

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`API error: ${response.status} - ${error}`);
    }

    const result = await response.json();
    console.log('\n5. Generation result:');
    console.log('   Block name:', result.blockName);
    console.log('   HTML length:', result.html?.length);
    console.log('   CSS length:', result.css?.length);
    console.log('   JS length:', result.js?.length);

    // Analyze the generated JS
    console.log('\n6. Analyzing generated JS pattern...');
    const js = result.js || '';

    // Check for correct pattern (iterating rows, accessing cells)
    const hasRowIteration = js.includes('block.children') || js.includes('[...block.children]');
    const hasCellAccess = js.includes('row.children') || js.includes('cells[');
    const hasWrongPattern = js.includes('type ===') || js.includes("type === 'image'") || js.includes('4 rows per');

    console.log('   ✓ Iterates over rows:', hasRowIteration);
    console.log('   ✓ Accesses cells within rows:', hasCellAccess);
    console.log('   ✗ Has wrong multi-row-per-item pattern:', hasWrongPattern);

    console.log('\n--- Generated JS ---');
    console.log(js);
    console.log('--- End JS ---\n');

    if (hasRowIteration && hasCellAccess && !hasWrongPattern) {
      console.log('✅ SUCCESS: Generated JS appears to use correct row/cell pattern!');
    } else if (hasWrongPattern) {
      console.log('❌ FAILURE: Generated JS still uses wrong pattern (multiple rows per item)');
    } else {
      console.log('⚠️  UNCERTAIN: Check the JS manually');
    }

    return result;

  } catch (error) {
    console.error('Test failed:', error.message);
    throw error;
  } finally {
    await browser.close();
  }
}

testBlockGeneration()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
