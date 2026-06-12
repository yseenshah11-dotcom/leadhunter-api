constconst express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');

const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/chrome-path', async (req, res) => {
  const { execSync } = require('child_process');
  try {
    const result = execSync('find /opt/render -name "chrome" -type f 2>/dev/null || find /root -name "chrome" -type f 2>/dev/null || which chromium-browser || which google-chrome || which chromium').toString();
    res.json({ paths: result.split('\n').filter(Boolean) });
  } catch(e) {
    res.json({ error: e.message, msg: "Chrome not found anywhere" });
  }
});

const seenBusinessIds = new Set();

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', seen: seenBusinessIds.size });
});

app.post('/api/scrape', async (req, res) => {
  const { niche, city, limit = 10 } = req.body;
  if (!niche || !city) return res.status(400).json({ error: 'niche and city are required' });

  const query = `${niche} in ${city}`;
  const leads = [];
  let browser;

  try {
    browser = await puppeteer.launch({
      headless: 'new',
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH ||
        '/opt/render/project/src/.cache/puppeteer/chrome/linux-121.0.6167.85/chrome-linux64/chrome',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-zygote',
        '--single-process'
      ]
    });

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1280, height: 800 });

    const searchUrl = `https://www.google.com/maps/search/${encodeURIComponent(query)}`;
    await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 3000));

    for (let i = 0; i < 4; i++) {
      await page.evaluate(() => {
        const feed = document.querySelector('[role="feed"]');
        if (feed) feed.scrollBy(0, 1000);
      });
      await new Promise(r => setTimeout(r, 1500));
    }

    const listingLinks = await page.evaluate(() => {
      const anchors = Array.from(document.querySelectorAll('a[href*="/maps/place/"]'));
      const unique = [...new Map(anchors.map(a => [a.href.split('?')[0], a.href])).values()];
      return unique.slice(0, 35);
    });

    console.log(`Found ${listingLinks.length} listings for "${query}"`);

    for (const link of listingLinks) {
      if (leads.length >= limit) break;

      const bizId = link.split('/maps/place/')[1]?.split('/')[0] || link;
      if (seenBusinessIds.has(bizId)) continue;

      try {
        const detailPage = await browser.newPage();
        await detailPage.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        await detailPage.goto(link, { waitUntil: 'networkidle2', timeout: 20000 });
        await new Promise(r => setTimeout(r, 2000));

        const hasWebsite = await detailPage.evaluate(() => {
          return !!Array.from(document.querySelectorAll('a, button')).find(el =>
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
          const name = document.querySelector('h1')?.innerText?.trim() ||
            document.title.replace(' - Google Maps', '').trim();

          const addressEl = document.querySelector('[data-item-id="address"]');
          const address = addressEl?.closest('[aria-label]')?.getAttribute('aria-label') || '';

          const phoneEl = document.querySelector('[data-item-id^="phone:tel"]');
          const phone = phoneEl?.closest('[aria-label]')?.getAttribute('aria-label') || '';

          const ratingEl = document.querySelector('[role="img"][aria-label*="star"]');
          const ratingMatch = (ratingEl?.getAttribute('aria-label') || '').match(/(\d+\.?\d*)/);
          const rating = ratingMatch ? parseFloat(ratingMatch[1]) : null;

          const reviewsEl = document.querySelector('button[aria-label*="review"]');
          const reviewsMatch = (reviewsEl?.getAttribute('aria-label') || '').match(/(\d[\d,]*)/);
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
