/**
 * Populate today's menu data including nutrients and dietary filters.
 *
 *   cd backend-folder
 *   node run-scrape.js           # normal run
 *   node run-scrape.js --force   # clear today's data and re-scrape
 *
 * Strategy: load the Angular page so Cloudflare issues clearance, intercept the
 * apiv4 XHRs the Angular app fires automatically (status_by_site and todays_menu),
 * then call apiv4.dineoncampus.com/locations/{id}/menu for each period via
 * page.evaluate(fetch) to get full nutrients and dietary filters.
 * We never call api.dineoncampus.com/v1 — that subdomain returns CF HTML from
 * page.evaluate even though apiv4 works fine.
 */
require('dotenv').config();
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
const { executablePath } = require('puppeteer');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('ERROR: Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in backend-folder/.env');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const ALLOWED_HALLS = ['Stetson', 'International', 'Belvidere'];

// DineOnCampus uses "-" for unknown and "7+" for approximate values.
// Strip the "+" and convert "-" to null so the numeric DB column accepts the value.
function parseNumeric(v) {
  if (v == null || v === '-' || v === '') return null;
  const n = parseFloat(String(v).replace('+', ''));
  return isNaN(n) ? null : n;
}
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const force = process.argv.includes('--force');
console.log(`Scraping menu data for ${today}...\n`);

async function clearToday() {
  const { data: items } = await supabase.from('menu_items').select('id').eq('date', today);
  if (items?.length) {
    await supabase.from('nutrients').delete().in('menu_item_id', items.map(i => i.id));
  }
  await supabase.from('menu_items').delete().eq('date', today);
  await supabase.from('stations').delete().eq('date', today);
  await supabase.from('periods').delete().eq('date', today);
  await supabase.from('locations').delete().eq('date', today);
  console.log('Cleared existing data for today.\n');
}

// Call any apiv4.dineoncampus.com URL from within the loaded page context.
// apiv4 is accessible because the Angular app already called it (clearance established).
async function apiv4Get(page, url) {
  const result = await page.evaluate(async (u) => {
    try {
      const res = await fetch(u, {
        headers: {
          'Accept': 'application/json, text/plain, */*',
          'Accept-Language': 'en-US,en;q=0.9',
          'Referer': 'https://dineoncampus.com/',
          'Origin': 'https://dineoncampus.com',
          'sec-fetch-dest': 'empty',
          'sec-fetch-mode': 'cors',
          'sec-fetch-site': 'same-site',
        }
      });
      const text = await res.text();
      return { status: res.status, body: text };
    } catch (e) {
      return { error: e.message };
    }
  }, url);

  if (result?.error) {
    console.warn(`  [apiv4] fetch error: ${result.error}`);
    return null;
  }
  if (!result.body?.trim().startsWith('{') && !result.body?.trim().startsWith('[')) {
    console.warn(`  [apiv4] HTTP ${result.status}, non-JSON: ${result.body?.slice(0, 100)}`);
    return null;
  }
  try { return JSON.parse(result.body); } catch { return null; }
}

async function main() {
  const { data: existing } = await supabase
    .from('menu_items').select('id').eq('date', today).limit(1);
  if (existing?.length) {
    if (!force) {
      console.log(`Menu data already exists for ${today}. Use --force to re-scrape.`);
      return;
    }
    await clearToday();
  }

  const browser = await puppeteer.launch({
    headless: true,
    executablePath: executablePath(),
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
    );

    // Intercept and store all apiv4/api dineoncampus JSON responses
    const captured = {};
    page.on('response', async (response) => {
      const url = response.url();
      if (!url.includes('dineoncampus.com')) return;
      const ct = response.headers()['content-type'] || '';
      if (!ct.includes('json')) return;
      try {
        const json = await response.json();
        const path = url.replace(/https?:\/\/[^/]+/, '').replace(/\?.*/, '');
        captured[path] = json;
        console.log(`  [XHR] ${url.replace(/\?.*/, '')}  keys: ${Object.keys(json || {}).slice(0, 6).join(', ')}`);
      } catch { /* ignore */ }
    });

    console.log('Loading DineOnCampus page...');
    await page.goto('https://dineoncampus.com/northeastern/whats-on-the-menu', {
      waitUntil: 'networkidle2',
      timeout: 60000,
    });
    // Wait for Angular to finish firing all its XHRs after networkidle2
    await new Promise(r => setTimeout(r, 3000));

    console.log('\nCaptured responses:', Object.keys(captured).join(', ') || '(none)');

    // todays_menu is the Angular homepage menu widget — it has locations with periods.
    // status_by_site only has open/closed status with no period structure.
    let locations = captured['/sites/todays_menu']?.locations;

    if (!locations?.length) {
      // Fall back: call todays_menu directly via page context
      console.log('\ntodays_menu not intercepted — calling directly...');
      const direct = await apiv4Get(page, 'https://apiv4.dineoncampus.com/sites/todays_menu');
      locations = direct?.locations;
    }

    if (!locations?.length) {
      throw new Error('Could not get location data from todays_menu');
    }

    console.log(`\nFound ${locations.length} locations total.`);

    // Log first dining hall's structure so we can verify period IDs are present
    const sample = locations.find(l => ALLOWED_HALLS.some(n => l.name?.includes(n)));
    if (sample) {
      console.log(`Sample location "${sample.name}" keys: ${Object.keys(sample).join(', ')}`);
      if (sample.periods?.length) {
        console.log(`  First period: ${JSON.stringify(sample.periods[0]).slice(0, 200)}`);
      } else {
        console.log(`  WARNING — no periods. Full sample: ${JSON.stringify(sample).slice(0, 400)}`);
      }
    }
    console.log();

    let totalItems = 0;
    const errors = [];

    for (const loc of locations) {
      if (!ALLOWED_HALLS.some(n => loc.name?.includes(n))) continue;
      console.log(`\n→ ${loc.name}`);

      const { data: dbLoc, error: locInsErr } = await supabase
        .from('locations')
        .insert({ original_id: loc.id, name: loc.name, date: today })
        .select().single();
      if (locInsErr) { errors.push(`location ${loc.name}: ${locInsErr.message}`); continue; }

      const periods = loc.periods ?? [];
      if (!periods.length) {
        console.log('  no periods in location data — skipping');
        continue;
      }

      for (const period of periods) {
        if (period.name === 'Everyday') continue;

        const { data: dbPeriod, error: perInsErr } = await supabase
          .from('periods')
          .insert({ original_id: period.id, location_id: dbLoc.id, name: period.name, date: today })
          .select().single();
        if (perInsErr) { errors.push(`period ${period.name}: ${perInsErr.message}`); continue; }

        // Fetch full menu (nutrients + dietary filters) from apiv4 via page context
        const menuData = await apiv4Get(page,
          `https://apiv4.dineoncampus.com/locations/${loc.id}/menu?date=${today}&period=${period.id}`
        );

        if (!menuData?.period?.categories?.length) {
          console.log(`  ${period.name}: no menu categories returned`);
          continue;
        }

        for (const category of menuData.period.categories) {
          const { data: dbStation, error: stInsErr } = await supabase
            .from('stations')
            .insert({ original_id: category.id ?? null, period_id: dbPeriod.id, name: category.name, date: today })
            .select().single();
          if (stInsErr) { errors.push(`station ${category.name}: ${stInsErr.message}`); continue; }

          for (const item of (category.items ?? [])) {
            const isVegan       = item.filters?.some(f => f.name === 'Vegan') ?? false;
            const isVegetarian  = item.filters?.some(f => f.name === 'Vegetarian' || f.name === 'Vegan') ?? false;
            const isHighProtein = item.filters?.some(f => f.name === 'Good Source of Protein') ?? false;

            const { data: dbItem, error: itemInsErr } = await supabase
              .from('menu_items')
              .insert({
                station_id:      dbStation.id,
                original_id:     item.id ?? null,
                name:            item.name,
                calories:        item.calories ?? null,
                portion:         item.portion ?? null,
                date:            today,
                is_vegetarian:   isVegetarian,
                is_vegan:        isVegan,
                is_high_protein: isHighProtein,
              })
              .select().single();
            if (itemInsErr) { errors.push(`item ${item.name}: ${itemInsErr.message}`); continue; }

            if (item.nutrients?.length) {
              const nutrients = item.nutrients.map(n => ({
                menu_item_id:  dbItem.id,
                name:          n.name,
                value:         n.value,
                uom:           n.uom,
                value_numeric: parseNumeric(n.valueNumeric),
              }));
              const { error: nutErr } = await supabase.from('nutrients').insert(nutrients);
              if (nutErr) errors.push(`nutrients for ${item.name}: ${nutErr.message}`);
            }
            totalItems++;
          }
          console.log(`  ${period.name} / ${category.name}: ${category.items?.length || 0} items`);
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
