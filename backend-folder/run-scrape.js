/**
 * Populate today's menu data including nutrients and dietary filters.
 *
 *   cd backend-folder
 *   node run-scrape.js
 *
 * Loads the DineOnCampus page via Puppeteer to establish a Cloudflare session,
 * then uses page.evaluate(fetch) for all API calls so cookies are sent automatically.
 * A second per-period call to apiv4.dineoncampus.com fetches nutrients + filters.
 */
require('dotenv').config();
const puppeteer = require('puppeteer');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('ERROR: Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in backend-folder/.env');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const SITE_ID = '5751fd2b90975b60e048929a';
const ALLOWED_HALLS = ['Stetson', 'International', 'Belvidere'];

const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
console.log(`Scraping menu data for ${today}...\n`);

async function fetchViaPage(page, url) {
  return page.evaluate(async (u) => {
    try {
      const res = await fetch(u);
      if (!res.ok) return null;
      return res.json();
    } catch {
      return null;
    }
  }, url);
}

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

  try {
    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
    );

    console.log('Loading DineOnCampus to establish session...');
    await page.goto('https://dineoncampus.com/northeastern/whats-on-the-menu', {
      waitUntil: 'networkidle2',
      timeout: 60000,
    });

    console.log('Fetching locations...');
    const locationsData = await fetchViaPage(page,
      `https://api.dineoncampus.com/v1/sites/${SITE_ID}/locations?date=${today}`
    );

    if (!locationsData?.locations?.length) {
      console.error('No locations returned:', JSON.stringify(locationsData));
      process.exit(1);
    }

    let totalItems = 0;
    const errors = [];

    for (const loc of locationsData.locations) {
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

        // Fetch detailed data (nutrients + dietary filters) for this period
        const detailed = await fetchViaPage(page,
          `https://apiv4.dineoncampus.com/locations/${loc.id}/menu?date=${today}&period=${period.id}`
        );

        const detailMap = new Map();
        if (detailed?.period?.categories) {
          for (const cat of detailed.period.categories) {
            for (const item of (cat.items ?? [])) {
              detailMap.set(item.name, item);
            }
          }
        }

        for (const station of (period.stations ?? [])) {
          const { data: dbStation, error: stInsErr } = await supabase
            .from('stations')
            .insert({ original_id: station.id, period_id: dbPeriod.id, name: station.name, date: today })
            .select().single();

          if (stInsErr) { errors.push(`station ${station.name}: ${stInsErr.message}`); continue; }

          for (const item of (station.items ?? [])) {
            const d = detailMap.get(item.name);
            const isVegan       = d?.filters?.some(f => f.name === 'Vegan') ?? false;
            const isVegetarian  = d?.filters?.some(f => f.name === 'Vegetarian' || f.name === 'Vegan') ?? false;
            const isHighProtein = d?.filters?.some(f => f.name === 'Good Source of Protein') ?? false;

            const { data: dbItem, error: itemInsErr } = await supabase
              .from('menu_items')
              .insert({
                station_id:   dbStation.id,
                original_id:  d?.id ?? null,
                name:         item.name,
                calories:     item.calories ?? null,
                portion:      item.portion ?? null,
                date:         today,
                is_vegetarian: isVegetarian,
                is_vegan:      isVegan,
                is_high_protein: isHighProtein,
              })
              .select().single();

            if (itemInsErr) { errors.push(`item ${item.name}: ${itemInsErr.message}`); continue; }

            if (d?.nutrients?.length) {
              const nutrients = d.nutrients.map(n => ({
                menu_item_id:  dbItem.id,
                name:          n.name,
                value:         n.value,
                uom:           n.uom,
                value_numeric: n.valueNumeric ?? null,
              }));
              const { error: nutErr } = await supabase.from('nutrients').insert(nutrients);
              if (nutErr) errors.push(`nutrients for ${item.name}: ${nutErr.message}`);
            }

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
  } finally {
    await browser.close();
  }
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
