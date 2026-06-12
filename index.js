const express = require('express');
const cors = require('cors');
const { chromium } = require('playwright');

const app = express();
app.use(cors());
app.use(express.json());

const seenBusinessIds = new Set();

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', seen: seenBusinessIds.size });
});

app.post('/api/scrape', async (req, res) => {
  const { niche, city, limit = 10 } = req.body;
  if (!niche || !city) {
    return res.status(400).json({ error: 'niche and city are required' });
  }

  const query = `${niche} in ${city}`;
  const leads = [];
  let browser;

  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-zygote',
        '--single-process',
        '--disable-extensions',
      ],
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
    });

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 },
    });

    const page = await context.newPage();
    page.setDefaultTimeout(30000);

    const searchUrl = `https://www.google.com/maps/search/${encodeURIComponent(query)}`;
    
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);

    // Accept cookies if prompted
    await page.click('button[aria-label*="Accept"]').catch(() => {});
    await page.waitForTimeout(1000);

    // Scroll results to load more
    for (let i = 0; i < 4; i++) {
      await page.evaluate(() => {
        const feed = document.querySelector('[role="feed"]');
        if (feed) feed.scrollBy(0, 1000);
      });
      await page.waitForTimeout(1500);
    }

    // Collect listing URLs
    const listingLinks = await page.$$eval(
      'a[href*="/maps/place/"]',
      (anchors) => [
        ...new Map(
          anchors
            .filter((a) => a.href.includes('/maps/place/'))
            .map((a) => [a.href.split('?')[0], a.href])
        ).values(),
      ].slice(0, 35)
    );

    console.log(`Found ${listingLinks.length} listings for "${query}"`);

    for (const link of listingLinks) {
      if (leads.length >= limit) break;

      const bizId = link.split('/maps/place/')[1]?.split('/')[0] || link;
      if (seenBusinessIds.has(bizId)) continue;

      try {
        const detailPage = await context.newPage();
        await detailPage.goto(link, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await detailPage.waitForTimeout(2000);

        const hasWebsite = await detailPage.evaluate(() => {
          return !!Array.from(document.querySelectorAll('a, button')).find(
            (el) =>
              el.getAttribute('data-item-id') === 'authority' ||
              (el.getAttribute('aria-label') || '').toLowerCase().includes('website') ||
              (el.innerText || '').toLowerCase().trim() === 'website'
          );
        });

        if (hasWebsite) {
          seenBusinessIds.add(bizId);
          await detailPage.close();
          continue;
        }

        const details = await detailPage.evaluate(() => {
          const name =
            document.querySelector('h1')?.innerText?.trim() ||
            document.title.replace(' - Google Maps', '').trim();

          const addressEl = document.querySelector('[data-item-id="address"]');
          const address = addressEl
            ? addressEl.closest('[aria-label]')?.getAttribute('aria-label') || ''
            : '';

          const phoneEl = document.querySelector('[data-item-id^="phone:tel"]');
          const phone = phoneEl
            ? phoneEl.closest('[aria-label]')?.getAttribute('aria-label') || ''
            : '';

          const ratingEl = document.querySelector('[role="img"][aria-label*="star"]');
          const ratingText = ratingEl?.getAttribute('aria-label') || '';
          const ratingMatch = ratingText.match(/(\d+\.?\d*)/);
          const rating = ratingMatch ? parseFloat(ratingMatch[1]) : null;

          const reviewsEl = document.querySelector('button[aria-label*="review"]');
          const reviewsText = reviewsEl?.getAttribute('aria-label') || '';
          const reviewsMatch = reviewsText.match(/(\d[\d,]*)/);
          const reviews = reviewsMatch ? parseInt(reviewsMatch[1].replace(',', '')) : null;

          const categoryEl = document.querySelector('button[jsaction*="category"]');
          const category = categoryEl?.innerText?.trim() || '';

          return { name, address, phone, rating, reviews, category };
        });

        if (!details.name || details.name.length < 2) {
          await detailPage.close();
          continue;
        }

        seenBusinessIds.add(bizId);
        leads.push({
          id: bizId,
          name: details.name,
          address: details.address.replace(/^Address:\s*/i, '').trim(),
          phone: details.phone.replace(/^Phone:\s*/i, '').trim(),
          rating: details.rating,
          reviews: details.reviews,
          category: details.category || niche,
          hasWebsite: false,
          gmapsUrl: link,
          foundAt: new Date().toISOString(),
        });

        console.log(`✓ ${details.name}`);
        await detailPage.close();
      } catch (err) {
        console.error(`Listing error: ${err.message}`);
      }
    }

    await browser.close();
    res.json({ success: true, leads, totalFound: leads.length, totalSeen: seenBusinessIds.size });

  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    console.error('Scrape error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/clear-history', (req, res) => {
  seenBusinessIds.clear();
  res.json({ success: true });
});

app.get('/api/stats', (req, res) => {
  res.json({ totalSeen: seenBusinessIds.size });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`LeadHunter API running on port ${PORT}`));
