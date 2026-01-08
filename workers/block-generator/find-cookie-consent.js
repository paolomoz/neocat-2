import { chromium } from 'playwright';

async function findCookieConsent() {
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();
  
  await page.goto('https://www.still.de/', { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(3000);
  
  // Look for cookie consent elements
  const buttons = await page.evaluate(() => {
    const results = [];
    document.querySelectorAll('button, a, [role="button"]').forEach(el => {
      const text = el.textContent?.trim().toLowerCase() || '';
      if (text.includes('akzept') || text.includes('accept') || text.includes('zustimm') || text.includes('agree') || text.includes('alle')) {
        results.push({
          tag: el.tagName,
          text: el.textContent?.trim().substring(0, 50),
          id: el.id,
          className: el.className,
          dataAttrs: Object.keys(el.dataset || {})
        });
      }
    });
    return results;
  });
  
  console.log('Found cookie consent buttons:', JSON.stringify(buttons, null, 2));
  
  await browser.close();
}

findCookieConsent();
