/**
 * Test the /block-generate-two-step endpoint on still.de carousel
 *
 * This captures a screenshot and HTML from still.de, then calls
 * the two-step endpoint to generate a block.
 */

import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

const WORKER_URL = process.env.WORKER_URL || 'http://localhost:8787';

async function testTwoStepEndpoint() {
  console.log('=== Testing /block-generate-two-step Endpoint ===\n');
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
      const acceptButton = await page.$('button[id*="accept"], button[class*="accept"], .cookie-consent button, #onetrust-accept-btn-handler, .uc-btn-accept-banner');
      if (acceptButton) {
        console.log('   Dismissing cookie consent...');
        await acceptButton.click();
        await page.waitForTimeout(1000);
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
    const screenshotBase64 = screenshotBuffer.toString('base64');
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
      // Get all img elements (excluding clones)
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

    // Step 5: Call the two-step endpoint
    console.log('\n5. Calling /block-generate-two-step endpoint...');

    const formData = new FormData();
    formData.append('url', 'https://www.still.de/');
    formData.append('screenshot', new Blob([screenshotBuffer], { type: 'image/png' }), 'screenshot.png');
    formData.append('html', carouselHtml);
    formData.append('backgroundImages', JSON.stringify(images));
    formData.append('mode', 'deterministic'); // Use deterministic for faithful content

    const response = await fetch(`${WORKER_URL}/block-generate-two-step`, {
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
      console.log(`Block Name: ${result.blockName}`);
      console.log(`Layout Pattern: ${result.layoutPattern}`);
      console.log(`Items Extracted: ${result.contentModel?.content?.items?.length || 'N/A'}`);

      console.log('\n--- Content Model Summary ---');
      if (result.contentModel) {
        const items = result.contentModel.content.items;
        items.forEach((item, i) => {
          const heading = item.cells.find(c => c.name === 'content')?.elements.find(e => e.type === 'heading');
          const cta = item.cells.find(c => c.name === 'cta')?.elements[0];
          console.log(`Slide ${i + 1}: ${heading?.text || 'No heading'}`);
          if (cta) {
            console.log(`         CTA: "${cta.text}" -> ${cta.href?.substring(0, 50)}...`);
          }
        });
      }

      console.log('\n--- Validation ---');
      if (result.validation) {
        console.log(`Valid: ${result.validation.isValid}`);
        console.log(`Errors: ${result.validation.errors?.length || 0}`);
        console.log(`Warnings: ${result.validation.warnings?.length || 0}`);
        if (result.validation.warnings?.length > 0) {
          result.validation.warnings.forEach(w => console.log(`  ⚠ ${w}`));
        }
      }

      console.log('\n--- Generated HTML (first 1000 chars) ---');
      console.log(result.html?.substring(0, 1000) || 'No HTML');

      // Save full results to file
      const outputPath = './test-results/two-step-result.json';
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, JSON.stringify(result, null, 2));
      console.log(`\n✓ Full results saved to ${outputPath}`);

      // Also save the generated files
      if (result.html) {
        fs.writeFileSync('./test-results/generated-block.html', result.html);
        console.log('✓ HTML saved to test-results/generated-block.html');
      }
      if (result.css) {
        fs.writeFileSync('./test-results/generated-block.css', result.css);
        console.log('✓ CSS saved to test-results/generated-block.css');
      }
      if (result.js) {
        fs.writeFileSync('./test-results/generated-block.js', result.js);
        console.log('✓ JS saved to test-results/generated-block.js');
      }

    } else {
      console.log('❌ Generation failed:', result.error);
    }

  } catch (error) {
    console.error('\n❌ Test failed:', error.message);

    if (error.message.includes('fetch failed') || error.message.includes('ECONNREFUSED')) {
      console.log('\nHint: Make sure the worker is running:');
      console.log('  cd workers/block-generator && npx wrangler dev --remote');
    }
  } finally {
    if (browser.isConnected()) {
      await browser.close();
    }
  }
}

testTwoStepEndpoint().catch(console.error);
