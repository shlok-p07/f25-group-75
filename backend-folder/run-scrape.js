/**
 * Populate today's menu data.
 *
 *   cd backend-folder
 *   node run-scrape.js
 *
 * Navigates the DineOnCampus Angular app and intercepts the todays_menu API
 * response that the app fetches automatically on page load. This bypasses
 * Cloudflare entirely because the request is made by the real browser JS engine.
 */
require('dotenv').config();
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('ERROR: Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in backend-folder/.env');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const ALLOWED_HALLS = ['Stetson', 'International', 'Belvidere'];

const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
console.log(`Scraping menu data for ${today}...\n`);

async function main() {
  const { data: existing } = await supabase
    .from('menu_items').select('id').eq('date', today).limit(1);
  if (existing && existing.length > 0) {
    console.log(`Menu data already exists for ${today}. Nothing to do.`);
    return;
  }

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  let siteData;
  try {
    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
    );

    // Intercept the todays_menu response the Angular app fetches automatically
    const menuPromise = page.waitForResponse(
      r => r.url().includes('todays_menu'),
      { timeout: 60000 }
    );
    page.goto('https://dineoncampus.com/northeastern/whats-on-the-menu', {
      waitUntil: 'load',
      timeout: 60000,
    }).catch(() => {});

    console.log('Waiting for menu data from DineOnCampus...');
    const menuResponse = await menuPromise;
    siteData = await menuResponse.json();
  } catch (err) {
    console.error('Failed to fetch menu data:', err.message);
    await browser.close();
    process.exit(1);
  } finally {
    await browser.close();
  }

  if (!siteData?.locations?.length) {
    console.error('No locations in response:', JSON.stringify(siteData));
    process.exit(1);
  }

  let totalItems = 0;
  const errors = [];

  for (const loc of siteData.locations) {
    if (!ALLOWED_HALLS.some(n => loc.name?.includes(n))) continue;
    console.log(`\n→ ${loc.name}`);

    const { data: dbLoc, error: locInsErr } = await supabase
      .from('locations')
      .insert({ original_id: loc.id, name: loc.name, date: today })
      .select().single();

    if (locInsErr) { errors.push(`location ${loc.name}: ${locInsErr.message}`); continue; }

    for (const period of (loc.periods ?? [])) {
      if (period.name === 'Everyday') continue;

      const { data: dbPeriod, error: perInsErr } = await supabase
        .from('periods')
        .insert({ original_id: period.id, location_id: dbLoc.id, name: period.name, date: today })
        .select().single();

      if (perInsErr) { errors.push(`period ${period.name}: ${perInsErr.message}`); continue; }

      for (const station of (period.stations ?? [])) {
        const { data: dbStation, error: stInsErr } = await supabase
          .from('stations')
          .insert({ original_id: station.id, period_id: dbPeriod.id, name: station.name, date: today })
          .select().single();

        if (stInsErr) { errors.push(`station ${station.name}: ${stInsErr.message}`); continue; }

        for (const item of (station.items ?? [])) {
          const { error: itemInsErr } = await supabase
            .from('menu_items')
            .insert({
              station_id:  dbStation.id,
              name:        item.name,
              calories:    item.calories ?? null,
              portion:     item.portion ?? null,
              date:        today,
            });

          if (itemInsErr) { errors.push(`item ${item.name}: ${itemInsErr.message}`); continue; }
          totalItems++;
        }
        console.log(`  ${period.name} / ${station.name}: ${station.items?.length || 0} items`);
      }
    }
  }

  await supabase.from('steast_vs_iv')
    .upsert({ date: today, steast: 0, iv: 0 }, { onConflict: 'date', ignoreDuplicates: true });

  if (errors.length) console.warn(`\nErrors (${errors.length}):\n`, errors.join('\n'));
  console.log(`\nDone! Inserted ${totalItems} menu items for ${today}.`);
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
