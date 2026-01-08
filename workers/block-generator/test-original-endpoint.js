/**
 * Test the /block-generate-full endpoint on still.de carousel
 */

import { chromium } from 'playwright';

const WORKER_URL = process.env.WORKER_URL || 'https://eds-block-generator.paolo-moz.workers.dev';

async function testOriginalEndpoint() {
  console.log('=== Testing /block-generate-full Endpoint ===\n');
  console.log(`Worker URL: ${WORKER_URL}\n`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 }
  });
  const page = await context.newPage();

  try {
    // Step 1: Navigate and capture
    console.log('1. Navigating to still.de...');
    await page.goto('https://www.still.de/', { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(2000);

    // Dismiss cookie consent if present
    console.log('   Checking for cookie consent...');
    try {
      // still.de uses "Alles akzeptieren" button with class ccm--save-settings
      const acceptButton = await page.$('button.ccm--save-settings, button[data-full-consent]');
      if (acceptButton) {
        console.log('   Dismissing cookie consent...');
        await acceptButton.click();
        await page.waitForTimeout(2000);
      }
    } catch (cookieError) {
      console.log('   No cookie consent or already dismissed');
    }

    await page.waitForTimeout(1000);

    // Step 2: Find and screenshot the carousel
    console.log('2. Capturing carousel screenshot...');
    const carouselSelector = '.content-stage-slideshow';
    const carousel = await page.$(carouselSelector);

    if (!carousel) {
      throw new Error('Carousel not found on page');
    }

    const screenshotBuffer = await carousel.screenshot({ type: 'png' });
    console.log(`   Screenshot size: ${(screenshotBuffer.length / 1024).toFixed(1)} KB`);

    // Step 3: Extract carousel HTML
    console.log('3. Extracting carousel HTML...');
    const carouselHtml = await page.evaluate((selector) => {
      const el = document.querySelector(selector);
      return el ? el.outerHTML : '';
    }, carouselSelector);
    console.log(`   HTML size: ${(carouselHtml.length / 1024).toFixed(1)} KB`);

    // Step 4: Extract background images
    console.log('4. Extracting images...');
    const images = await page.evaluate((selector) => {
      const el = document.querySelector(selector);
      if (!el) return [];

      const imgs = [];
      el.querySelectorAll('.content-stage-slideshow__slide:not(.slick-cloned) img').forEach(img => {
        const src = img.src || img.getAttribute('data-src') || '';
        if (src && !src.includes('clear.gif') && !src.includes('spacer')) {
          imgs.push({
            src: src,
            alt: img.alt || '',
            role: 'photo'
          });
        }
      });
      return imgs;
    }, carouselSelector);
    console.log(`   Found ${images.length} images`);

    await browser.close();

    // Step 5: Call the original endpoint
    console.log('\n5. Calling /block-generate-full endpoint...');

    const formData = new FormData();
    formData.append('url', 'https://www.still.de/');
    formData.append('screenshot', new Blob([screenshotBuffer], { type: 'image/png' }), 'screenshot.png');
    formData.append('html', carouselHtml);
    formData.append('backgroundImages', JSON.stringify(images));
    formData.append('refinements', '0');

    const response = await fetch(`${WORKER_URL}/block-generate-full`, {
      method: 'POST',
      body: formData
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`API error: ${response.status} - ${errorText}`);
    }

    const result = await response.json();

    // Step 6: Display results
    console.log('\n=== GENERATION RESULTS ===\n');

    if (result.success) {
      const iterations = result.iterations || [];
      console.log(`Iterations: ${iterations.length}`);

      for (const iter of iterations) {
        console.log(`\n--- Iteration ${iter.iteration} ---`);
        console.log(`Block Name: ${iter.blockName}`);
        console.log(`HTML length: ${iter.html?.length || 0} chars`);
        console.log(`CSS length: ${iter.css?.length || 0} chars`);
        console.log(`JS length: ${iter.js?.length || 0} chars`);

        // Count slides in generated HTML
        const slideMatches = iter.html?.match(/<div>/g) || [];
        console.log(`Approximate rows: ${Math.floor(slideMatches.length / 3)}`);

        // Count actual slides by looking for row pattern
        const rowPattern = /<div>\s*<div>/g;
        const rowMatches = iter.html?.match(rowPattern) || [];
        console.log(`Actual slide count: ${rowMatches.length}`);

        console.log('\n--- Generated HTML (first 3000 chars) ---');
        console.log(iter.html?.substring(0, 3000) || 'No HTML');
      }

    } else {
      console.log('Generation failed:', result.error);
    }

  } catch (error) {
    console.error('\nTest failed:', error.message);
  } finally {
    if (browser.isConnected()) {
      await browser.close();
    }
  }
}

testOriginalEndpoint().catch(console.error);
