const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({
  host: process.env.PGHOST,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE,
  port: parseInt(process.env.PGPORT),
  ssl: { rejectUnauthorized: false }
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS seen_businesses (
      id TEXT PRIMARY KEY,
      name TEXT,
      added_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS leads (
      id TEXT PRIMARY KEY,
      name TEXT,
      address TEXT,
      phone TEXT,
      rating FLOAT,
      reviews INT,
      category TEXT,
      niche TEXT,
      city TEXT,
      gmaps_url TEXT,
      found_at TIMESTAMP DEFAULT NOW()
    );
  `);
  console.log('Database initialized');
}

initDB().catch(console.error);

const activeScans = {};

const NON_BUSINESS_KEYWORDS = [
  'park', 'school', 'church', 'temple', 'mosque', 'library', 'government',
  'city of', 'county of', 'state of', 'department of', 'united states',
  'post office', 'dmv', 'courthouse', 'fire station', 'police station',
  'hospital', 'university', 'college', 'elementary', 'middle school',
  'high school', 'national park', 'recreation center', 'community center',
  'public', 'municipal', 'federal', 'nonprofit', 'non-profit'
];

function isRealBusiness(name, category) {
  const combined = `${name} ${category}`.toLowerCase();
  return !NON_BUSINESS_KEYWORDS.some(kw => combined.includes(kw));
}

async function isSeen(bizId) {
  const result = await pool.query('SELECT id FROM seen_businesses WHERE id = $1', [bizId]);
  return result.rows.length > 0;
}

async function markSeen(bizId, name) {
  await pool.query(
    'INSERT INTO seen_businesses (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING',
    [bizId, name]
  );
}

async function saveLead(lead) {
  await pool.query(`
    INSERT INTO leads (id, name, address, phone, rating, reviews, category, niche, city, gmaps_url)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    ON CONFLICT (id) DO NOTHING
  `, [lead.id, lead.name, lead.address, lead.phone, lead.rating, lead.reviews, lead.category, lead.niche, lead.city, lead.gmapsUrl]);
}

async function getSeenCount() {
  const result = await pool.query('SELECT COUNT(*) FROM seen_businesses');
  return parseInt(result.rows[0].count);
}

async function getAllLeads() {
  const result = await pool.query('SELECT * FROM leads ORDER BY found_at DESC');
  return result.rows;
}

app.get('/api/health', async (req, res) => {
  const seenCount = await getSeenCount().catch(() => 0);
  res.json({ status: 'ok', seen: seenCount, activeScans: Object.keys(activeScans).length });
});

app.get('/api/scan-progress/:scanId', (req, res) => {
  const scan = activeScans[req.params.scanId];
  if (!scan) return res.status(404).json({ error: 'Scan not found' });
  res.json(scan);
});

app.get('/api/all-leads', async (req, res) => {
  const leads = await getAllLeads().catch(() => []);
  res.json({ leads, total: leads.length });
});

app.get('/api/stats', async (req, res) => {
  const seenCount = await getSeenCount().catch(() => 0);
  res.json({ totalSeen: seenCount, activeScans: Object.keys(activeScans).length });
});

app.post('/api/scrape', async (req, res) => {
  const { niche, city, limit = 10, mode = 'normal' } = req.body;
  if (!niche || !city) return res.status(400).json({ error: 'niche and city are required' });

  const scanId = Date.now().toString();
  activeScans[scanId] = {
    status: 'running',
    niche, city, mode,
    leads: [],
    totalScanned: 0,
    totalFound: 0,
    totalListings: 0,
    progress: 0,
    startedAt: new Date().toISOString()
  };

  const actualLimit = mode === 'overnight' ? 500 : mode === 'unlimited' ? 99999 : limit;

  runScrape(niche, city, actualLimit, scanId, mode).catch(err => {
    if (activeScans[scanId]) {
      activeScans[scanId].status = 'error';
      activeScans[scanId].error = err.message;
    }
  });

  // Always return scanId immediately — frontend polls for progress
  res.json({ scanId, status: 'started', message: 'Scan running in background' });
});

async function runScrape(niche, city, limit, scanId, mode) {
  const leads = [];
  let browser;
  let page;
  let totalScanned = 0;

  async function launchBrowser() {
    browser = await puppeteer.launch({
      headless: 'new',
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-zygote',
        '--single-process',
        '--disable-extensions',
        '--memory-pressure-off'
      ]
    });
    page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1280, height: 800 });
  }

  try {
    await launchBrowser();

    const searchQueries = [
      `${niche} in ${city}`,
      `${niche} near ${city}`,
      `best ${niche} ${city}`,
      `local ${niche} ${city}`,
      `affordable ${niche} ${city}`,
    ];

    let allListingLinks = [];

    for (const searchQuery of searchQueries) {
      if (allListingLinks.length >= limit * 10) break;

      console.log(`Searching: ${searchQuery}`);
      const searchUrl = `https://www.google.com/maps/search/${encodeURIComponent(searchQuery)}`;
      await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await new Promise(r => setTimeout(r, 2000));

      const maxScrolls = mode === 'overnight' ? 200 : mode === 'unlimited' ? 150 : Math.ceil(limit * 5);
      let scrollAttempts = 0;
      let reachedEnd = false;

      while (scrollAttempts < maxScrolls && !reachedEnd) {
        await page.evaluate(() => {
          const feed = document.querySelector('[role="feed"]');
          if (feed) feed.scrollBy(0, 1500);
        });
        await new Promise(r => setTimeout(r, 400));
        scrollAttempts++;

        reachedEnd = await page.evaluate(() => {
          const feed = document.querySelector('[role="feed"]');
          return !!document.querySelector('.HlvSq') ||
            (feed && feed.innerText.includes("You've reached the end"));
        });

        const newLinks = await page.evaluate(() => {
          const anchors = Array.from(document.querySelectorAll('a[href*="/maps/place/"]'));
          return [...new Map(anchors.map(a => [a.href.split('?')[0], a.href])).values()];
        });

        const existingSet = new Set(allListingLinks);
        for (const link of newLinks) {
          if (!existingSet.has(link)) {
            allListingLinks.push(link);
            existingSet.add(link);
          }
        }

        if (activeScans[scanId]) {
          activeScans[scanId].totalListings = allListingLinks.length;
          activeScans[scanId].progress = Math.min(Math.round((scrollAttempts / maxScrolls) * 15), 15);
          activeScans[scanId].status = 'loading_listings';
        }

        if (reachedEnd) break;
      }

      console.log(`Total unique listings so far: ${allListingLinks.length}`);
    }

    const listingLinks = allListingLinks;
    console.log(`Total listings to check: ${listingLinks.length}`);

    if (activeScans[scanId]) {
      activeScans[scanId].status = 'checking_listings';
      activeScans[scanId].totalListings = listingLinks.length;
    }

    for (let i = 0; i < listingLinks.length; i++) {
      const link = listingLinks[i];
      if (leads.length >= limit) break;

      if (i > 0 && i % 10 === 0) {
        console.log(`Restarting browser at listing ${i} to free memory...`);
        await browser.close().catch(() => {});
        await launchBrowser();
      }

      const bizId = link.split('/maps/place/')[1]?.split('/')[0] || link;

      const seen = await isSeen(bizId).catch(() => false);
      if (seen) continue;

      try {
        await page.goto(link, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await new Promise(r => setTimeout(r, 600));

        const result = await page.evaluate(() => {
          const hasWebsite = !!document.querySelector('a[data-item-id="authority"]');
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
          return { hasWebsite, name, address, phone, rating, reviews, category };
        });

        await markSeen(bizId, result.name).catch(() => {});
        totalScanned++;

        if (result.hasWebsite || !result.name || result.name.length < 2) {
          console.log(`✗ Has website: ${result.name}`);
          continue;
        }

        if (!isRealBusiness(result.name, result.category)) {
          console.log(`✗ Not a business: ${result.name}`);
          continue;
        }

        const lead = {
          id: bizId,
          name: result.name,
          address: result.address.replace(/^Address:\s*/i, '').trim(),
          phone: result.phone.replace(/^Phone:\s*/i, '').trim(),
          rating: result.rating,
          reviews: result.reviews,
          category: result.category || niche,
          niche,
          city,
          hasWebsite: false,
          gmapsUrl: link,
          foundAt: new Date().toISOString(),
        };

        leads.push(lead);
        await saveLead(lead).catch(() => {});
        console.log(`✓ ${result.name} (${leads.length}/${limit === 99999 ? '∞' : limit})`);

        if (activeScans[scanId]) {
          activeScans[scanId].leads = [...leads];
          activeScans[scanId].totalFound = leads.length;
          activeScans[scanId].totalScanned = totalScanned;
          activeScans[scanId].progress = 15 + Math.round((i / listingLinks.length) * 85);
        }

      } catch (err) {
        console.error(`Listing error: ${err.message}`);
      }
    }

    await browser.close();

    if (activeScans[scanId]) {
      activeScans[scanId].status = 'done';
      activeScans[scanId].progress = 100;
      activeScans[scanId].leads = leads;
      activeScans[scanId].totalFound = leads.length;
      activeScans[scanId].totalScanned = totalScanned;
      activeScans[scanId].completedAt = new Date().toISOString();
    }

    return { success: true, leads, totalFound: leads.length, totalScanned, totalSeen: await getSeenCount() };

  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    if (activeScans[scanId]) {
      activeScans[scanId].status = 'error';
      activeScans[scanId].error = err.message;
    }
    throw err;
  }
}

app.post('/api/clear-history', async (req, res) => {
  await pool.query('DELETE FROM seen_businesses').catch(() => {});
  await pool.query('DELETE FROM leads').catch(() => {});
  res.json({ success: true });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`LeadHunter API running on port ${PORT}`));
