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
      name TEXT NOT NULL,
      address TEXT,
      phone TEXT,
      rating FLOAT,
      reviews INT,
      category TEXT,
      niche TEXT,
      city TEXT,
      gmaps_url TEXT,
      status TEXT DEFAULT 'new',
      notes TEXT DEFAULT '',
      found_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);
  console.log('Database initialized');
}

initDB().catch(console.error);

const activeScans = {};

const NICHES = {
  'Home Services': [
    'HVAC contractor', 'roofing contractor', 'plumber', 'electrician',
    'landscaping', 'pest control', 'painting contractor', 'cleaning service',
    'general contractor', 'handyman', 'pressure washing', 'carpet cleaning',
    'tree service', 'pool service', 'fence contractor', 'deck builder',
    'flooring contractor', 'garage door repair', 'window cleaning', 'drywall contractor'
  ],
  'Professional': [
    'dentist', 'chiropractor', 'optometrist', 'veterinarian',
    'accountant', 'attorney', 'real estate agent', 'insurance agent',
    'therapist', 'financial advisor'
  ],
  'Retail & Food': [
    'restaurant', 'bakery', 'barbershop', 'hair salon', 'nail salon',
    'laundromat', 'auto repair', 'auto detailing', 'towing service',
    'gym', 'yoga studio', 'tattoo shop', 'daycare', 'moving company', 'locksmith'
  ]
};

const NON_BUSINESS_KEYWORDS = [
  'park', 'school', 'church', 'temple', 'mosque', 'library',
  'city of', 'county of', 'state of', 'department of',
  'post office', 'dmv', 'courthouse', 'fire station', 'police station',
  'hospital', 'university', 'college', 'elementary', 'middle school',
  'high school', 'national park', 'recreation center', 'community center',
  'municipal', 'federal', 'nonprofit'
];

function isRealBusiness(name, category) {
  const combined = `${name} ${category}`.toLowerCase();
  return !NON_BUSINESS_KEYWORDS.some(kw => combined.includes(kw));
}

async function isSeen(bizId) {
  try {
    const result = await pool.query('SELECT id FROM seen_businesses WHERE id = $1', [bizId]);
    return result.rows.length > 0;
  } catch { return false; }
}

async function markSeen(bizId, name) {
  try {
    await pool.query(
      'INSERT INTO seen_businesses (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING',
      [bizId, name || '']
    );
  } catch {}
}

async function saveLead(lead) {
  try {
    await pool.query(`
      INSERT INTO leads (id, name, address, phone, rating, reviews, category, niche, city, gmaps_url, status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'new')
      ON CONFLICT (id) DO NOTHING
    `, [lead.id, lead.name, lead.address, lead.phone, lead.rating,
        lead.reviews, lead.category, lead.niche, lead.city, lead.gmapsUrl]);
  } catch {}
}

// ─── API Routes ───────────────────────────────────────────────────────────────

app.get('/api/health', async (req, res) => {
  const seen = await pool.query('SELECT COUNT(*) FROM seen_businesses').catch(() => ({ rows: [{ count: 0 }] }));
  const leads = await pool.query('SELECT COUNT(*) FROM leads').catch(() => ({ rows: [{ count: 0 }] }));
  res.json({
    status: 'ok',
    totalSeen: parseInt(seen.rows[0].count),
    totalLeads: parseInt(leads.rows[0].count),
    activeScans: Object.keys(activeScans).length
  });
});

app.get('/api/niches', (req, res) => {
  res.json(NICHES);
});

app.get('/api/leads', async (req, res) => {
  try {
    const { niche, status, city, search } = req.query;
    let query = 'SELECT * FROM leads WHERE 1=1';
    const params = [];

    if (niche) { params.push(niche); query += ` AND niche ILIKE $${params.length}`; }
    if (status) { params.push(status); query += ` AND status = $${params.length}`; }
    if (city) { params.push(`%${city}%`); query += ` AND city ILIKE $${params.length}`; }
    if (search) {
      params.push(`%${search}%`);
      query += ` AND (name ILIKE $${params.length} OR address ILIKE $${params.length} OR phone ILIKE $${params.length})`;
    }

    query += ' ORDER BY found_at DESC';
    const result = await pool.query(query, params);
    res.json({ leads: result.rows, total: result.rows.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/leads/:id', async (req, res) => {
  try {
    const { status, notes } = req.body;
    const updates = [];
    const params = [];

    if (status !== undefined) { params.push(status); updates.push(`status = $${params.length}`); }
    if (notes !== undefined) { params.push(notes); updates.push(`notes = $${params.length}`); }

    if (updates.length === 0) return res.status(400).json({ error: 'Nothing to update' });

    params.push(req.params.id);
    await pool.query(
      `UPDATE leads SET ${updates.join(', ')}, updated_at = NOW() WHERE id = $${params.length}`,
      params
    );
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/leads/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM leads WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/stats', async (req, res) => {
  try {
    const total = await pool.query('SELECT COUNT(*) FROM leads');
    const byStatus = await pool.query('SELECT status, COUNT(*) as count FROM leads GROUP BY status');
    const byNiche = await pool.query('SELECT niche, COUNT(*) as count FROM leads GROUP BY niche ORDER BY count DESC');
    const seen = await pool.query('SELECT COUNT(*) FROM seen_businesses');

    res.json({
      totalLeads: parseInt(total.rows[0].count),
      totalSeen: parseInt(seen.rows[0].count),
      byStatus: byStatus.rows.reduce((acc, r) => ({ ...acc, [r.status]: parseInt(r.count) }), {}),
      byNiche: byNiche.rows.map(r => ({ niche: r.niche, count: parseInt(r.count) })),
      activeScans: Object.keys(activeScans).length
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/scan-progress/:scanId', (req, res) => {
  const scan = activeScans[req.params.scanId];
  if (!scan) return res.status(404).json({ error: 'Scan not found' });
  res.json(scan);
});

app.post('/api/scrape', async (req, res) => {
  const { niche, city, limit = 10 } = req.body;
  if (!niche || !city) return res.status(400).json({ error: 'niche and city are required' });

  const scanId = Date.now().toString();
  activeScans[scanId] = {
    status: 'running',
    statusMessage: 'Starting scan...',
    niche, city, limit,
    leads: [],
    totalScanned: 0,
    totalFound: 0,
    totalListings: 0,
    progress: 0,
    startedAt: new Date().toISOString()
  };

  runScrape(niche, city, limit, scanId).catch(err => {
    if (activeScans[scanId]) {
      activeScans[scanId].status = 'error';
      activeScans[scanId].error = err.message;
    }
  });

  res.json({ scanId, status: 'started' });
});

app.post('/api/clear-history', async (req, res) => {
  try {
    await pool.query('DELETE FROM seen_businesses');
    await pool.query('DELETE FROM leads');
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Scraper ─────────────────────────────────────────────────────────────────

async function runScrape(niche, city, limit, scanId) {
  const leads = [];
  let browser;
  let page;
  let totalScanned = 0;

  function updateScan(updates) {
    if (activeScans[scanId]) {
      Object.assign(activeScans[scanId], updates);
    }
  }

  async function launchBrowser() {
    if (browser) await browser.close().catch(() => {});
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
        '--memory-pressure-off',
        '--disable-background-networking',
        '--disable-default-apps',
        '--mute-audio'
      ]
    });
    page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1280, height: 800 });
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const type = req.resourceType();
      if (['image', 'stylesheet', 'font', 'media'].includes(type)) {
        req.abort();
      } else {
        req.continue();
      }
    });
  }

  try {
    await launchBrowser();

    // Multiple search queries to maximize listings found
    const searchQueries = [
      `${niche} in ${city}`,
      `${niche} near ${city}`,
      `local ${niche} ${city}`,
    ];

    let allListingLinks = [];

    for (const searchQuery of searchQueries) {
      if (allListingLinks.length >= limit * 8) break;

      updateScan({ statusMessage: `Searching: ${searchQuery}` });
      console.log(`Searching: ${searchQuery}`);

      try {
        await page.goto(
          `https://www.google.com/maps/search/${encodeURIComponent(searchQuery)}`,
          { waitUntil: 'domcontentloaded', timeout: 30000 }
        );
        await new Promise(r => setTimeout(r, 1500));

        // Scroll to load listings
        const maxScrolls = Math.min(Math.ceil(limit * 3), 60);
        let scrollAttempts = 0;
        let reachedEnd = false;

        while (scrollAttempts < maxScrolls && !reachedEnd) {
          await page.evaluate(() => {
            const feed = document.querySelector('[role="feed"]');
            if (feed) feed.scrollBy(0, 2000);
          }).catch(() => {});
          await new Promise(r => setTimeout(r, 500));
          scrollAttempts++;

          reachedEnd = await page.evaluate(() => {
            const feed = document.querySelector('[role="feed"]');
            return !feed || feed.innerText.includes("You've reached the end") ||
              !!document.querySelector('.HlvSq');
          }).catch(() => false);

          const newLinks = await page.evaluate(() => {
            return [...new Map(
              Array.from(document.querySelectorAll('a[href*="/maps/place/"]'))
                .map(a => [a.href.split('?')[0], a.href])
            ).values()];
          }).catch(() => []);

          const existingSet = new Set(allListingLinks);
          for (const link of newLinks) {
            if (!existingSet.has(link)) allListingLinks.push(link);
          }

          updateScan({
            totalListings: allListingLinks.length,
            statusMessage: `Loading listings... ${allListingLinks.length} found`
          });

          if (reachedEnd || allListingLinks.length >= limit * 8) break;
        }
      } catch (err) {
        console.error(`Search error: ${err.message}`);
      }
    }

    console.log(`Total listings to check: ${allListingLinks.length}`);
    updateScan({
      totalListings: allListingLinks.length,
      statusMessage: `Checking ${allListingLinks.length} businesses...`
    });

    // Check each listing
    for (let i = 0; i < allListingLinks.length; i++) {
      if (leads.length >= limit) break;

      // Restart browser every 15 listings to prevent memory issues
      if (i > 0 && i % 15 === 0) {
        console.log(`Memory refresh at listing ${i}`);
        await launchBrowser();
      }

      const link = allListingLinks[i];
      const bizId = link.split('/maps/place/')[1]?.split('/')[0] || link;

      const seen = await isSeen(bizId);
      if (seen) continue;

      try {
        await page.goto(link, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await new Promise(r => setTimeout(r, 400));

        const result = await page.evaluate(() => {
          const hasWebsite = !!document.querySelector('a[data-item-id="authority"]');
          const name = document.querySelector('h1')?.innerText?.trim() || '';
          const address = document.querySelector('[data-item-id="address"]')
            ?.closest('[aria-label]')?.getAttribute('aria-label') || '';
          const phone = document.querySelector('[data-item-id^="phone:tel"]')
            ?.closest('[aria-label]')?.getAttribute('aria-label') || '';
          const ratingText = document.querySelector('[role="img"][aria-label*="star"]')
            ?.getAttribute('aria-label') || '';
          const rating = parseFloat((ratingText.match(/(\d+\.?\d*)/) || [])[1]) || null;
          const reviewsText = document.querySelector('button[aria-label*="review"]')
            ?.getAttribute('aria-label') || '';
          const reviews = parseInt((reviewsText.match(/(\d[\d,]*)/) || [])[1]?.replace(',', '')) || null;
          const category = document.querySelector('button[jsaction*="category"]')?.innerText?.trim() || '';
          return { hasWebsite, name, address, phone, rating, reviews, category };
        });

        await markSeen(bizId, result.name);
        totalScanned++;

        updateScan({
          totalScanned,
          progress: Math.round((i / allListingLinks.length) * 100),
          statusMessage: `Checking business ${i + 1} of ${allListingLinks.length}...`
        });

        if (result.hasWebsite || !result.name || result.name.length < 2) continue;
        if (!isRealBusiness(result.name, result.category)) continue;

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
          status: 'new',
          foundAt: new Date().toISOString(),
        };

        leads.push(lead);
        await saveLead(lead);
        console.log(`✓ ${result.name} (${leads.length}/${limit})`);

        updateScan({
          leads: [...leads],
          totalFound: leads.length,
          statusMessage: `Found ${leads.length} lead${leads.length !== 1 ? 's' : ''} so far...`
        });

      } catch (err) {
        console.error(`Listing error: ${err.message}`);
      }
    }

    await browser.close().catch(() => {});

    updateScan({
      status: 'done',
      progress: 100,
      leads,
      totalFound: leads.length,
      totalScanned,
      statusMessage: `Done! Found ${leads.length} lead${leads.length !== 1 ? 's' : ''}.`,
      completedAt: new Date().toISOString()
    });

    console.log(`Scan complete: ${leads.length} leads from ${totalScanned} checked`);

  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    updateScan({ status: 'error', error: err.message });
    throw err;
  }
}

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`LeadHunter API running on port ${PORT}`));
