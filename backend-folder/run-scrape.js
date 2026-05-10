/**
 * Populate today's menu data including nutrients and dietary filters.
 *
 *   cd backend-folder
 *   node run-scrape.js           # normal run
 *   node run-scrape.js --force   # clear today's data and re-scrape
 *
 * Strategy: load dineoncampus.com so Cloudflare issues clearance, intercept
 * the apiv4 XHRs the Angular app fires, then navigate directly to each
 * apiv4 URL (browser navigation — no CORS restriction) for full menu data.
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

function parseNumeric(v) {
  if (v == null || v === '-' || v === '') return null;
  const n = parseFloat(String(v).replace('+', ''));
  return isNaN(n) ? null : n;
}

const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const force = process.argv.includes('--force');
const timestamp = new Date().toISOString();
console.log(`\n[${timestamp}] Scraping menu data for ${today}...\n`);

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

// Navigate the browser to a URL and return parsed JSON from the page body.
// Uses browser navigation (not fetch) so Cloudflare cookies apply and CORS is irrelevant.
async function browserGet(browser, url) {
  const page = await browser.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const text = await page.evaluate(() => document.body.innerText);
    return JSON.parse(text);
  } finally {
    await page.close();
  }
}

async function main() {
  // When launched by launchd (--background), wait for network to stabilize after wake
  if (process.argv.includes('--background')) {
    console.log('Waiting 60s for network to stabilize...');
    await new Promise(r => setTimeout(r, 60000));
  }

  const { data: existing } = await supabase
    .from('menu_items').select('id').eq('date', today).limit(1);
  const { data: existingLocs } = await supabase
    .from('locations').select('id').eq('date', today).limit(1);

  const hasItems = existing?.length > 0;
  const hasLocs  = existingLocs?.length > 0;

  if (hasItems && hasLocs && !force) {
    console.log(`Menu data already exists for ${today}. Use --force to re-scrape.`);
    return;
  }

  if (hasItems || hasLocs) {
    if (!(hasItems && hasLocs)) {
      console.log(`Partial data found (items=${hasItems}, locations=${hasLocs}) — clearing and re-scraping...`);
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

    // Intercept apiv4 XHRs fired by the Angular app
    const captured = {};
    page.on('response', async (response) => {
      const url = response.url();
      if (!url.includes('dineoncampus.com')) return;
      if (!(response.headers()['content-type'] || '').includes('json')) return;
      try {
        const json = await response.json();
        const path = url.replace(/https?:\/\/[^/]+/, '').replace(/\?.*/, '');
        captured[path] = json;
        console.log(`  [XHR] ${url.replace(/\?.*/, '')}`);
      } catch { /* ignore */ }
    });

    console.log('Loading new.dineoncampus.com (getting Cloudflare clearance)...');
    let loaded = false;
    for (let attempt = 1; attempt <= 3 && !loaded; attempt++) {
      try {
        if (attempt > 1) {
          console.log(`  Retry attempt ${attempt}...`);
          await new Promise(r => setTimeout(r, 15000));
        }
        await page.goto('https://new.dineoncampus.com/public', {
          waitUntil: 'domcontentloaded',
          timeout: 90000,
        });
        loaded = true;
      } catch (e) {
        console.warn(`  Page load attempt ${attempt} failed: ${e.message}`);
      }
    }
    if (!loaded) throw new Error('Failed to load DineOnCampus after 3 attempts');
    await new Promise(r => setTimeout(r, 4000));

    // Use the new locations-public endpoint (returns full location list grouped by building).
    // Per-location periods + menu come from /locations/{id}/periods and /locations/{id}/menu.
    let locations = [];
    try {
      const locsData = await browserGet(browser,
        'https://apiv4.dineoncampus.com/sites/5751fd2b90975b60e048929a/locations-public?for_menus=true'
      );
      const flat = (locsData?.buildings || []).flatMap(b => b.locations || []);
      const filtered = flat.filter(l => ALLOWED_HALLS.some(n => l.name?.includes(n)));
      // Fetch periods for each filtered location
      for (const loc of filtered) {
        try {
          const periodsData = await browserGet(browser,
            `https://apiv4.dineoncampus.com/locations/${loc.id}/periods/?date=${today}`
          );
          const periods = periodsData?.periods || [];
          if (periods.length) {
            locations.push({ id: loc.id, name: loc.name, periods });
          } else {
            console.log(`  ${loc.name}: no periods for ${today}`);
          }
        } catch (e) {
          console.warn(`  Failed to fetch periods for ${loc.name}:`, e.message);
        }
      }
    } catch (e) {
      console.error('locations-public fetch failed:', e.message);
    }

    if (!locations?.length) {
      console.log(`Menu not posted yet for ${today} — will retry at next scheduled run.`);
      return;
    }

    console.log(`\nFound ${locations.length} locations.\n`);

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

      for (const period of (loc.periods ?? [])) {
        if (period.name === 'Everyday') continue;

        const { data: dbPeriod, error: perInsErr } = await supabase
          .from('periods')
          .insert({ original_id: period.id, location_id: dbLoc.id, name: period.name, date: today })
          .select().single();
        if (perInsErr) { errors.push(`period ${period.name}: ${perInsErr.message}`); continue; }

        let menuData = captured[`/locations/${loc.id}/menu`];
        if (!menuData) {
          try {
            menuData = await browserGet(browser,
              `https://apiv4.dineoncampus.com/locations/${loc.id}/menu?date=${today}&period=${period.id}`
            );
          } catch (e) {
            console.warn(`  Could not fetch menu for ${period.name}:`, e.message);
            continue;
          }
        }

        if (!menuData?.period?.categories?.length) {
          console.log(`  ${period.name}: no categories`);
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

    // ── Scrape weekly hours (all locations campus-wide, not just menu halls) ─
    console.log('\nFetching weekly hours...');
    try {
      const scheduleData = await browserGet(browser,
        `https://apiv4.dineoncampus.com/locations/weekly_schedule?site_id=5751fd2b90975b60e048929a&date=${today}`
      );
      if (scheduleData?.theLocations?.length) {
        let hoursCount = 0;
        for (const loc of scheduleData.theLocations) {
          for (const day of (loc.week || [])) {
            const { error: hErr } = await supabase.from('location_hours').upsert({
              location_original_id: loc.id,
              location_name:        loc.name,
              location_slug:        loc.slug ?? null,
              date:                 day.date,
              day_of_week:          day.day,
              status:               day.status || (day.closed ? 'closed' : 'open'),
              hours:                day.hours || [],
              has_special_hours:    day.has_special_hours || false,
              always_open:          day.always_open || false,
              scraped_at:           new Date().toISOString(),
            }, { onConflict: 'location_original_id,date' });
            if (!hErr) hoursCount++;
            else errors.push(`hours ${loc.name} ${day.date}: ${hErr.message}`);
          }
        }
        console.log(`Updated hours for ${hoursCount} location-days across ${scheduleData.theLocations.length} locations.`);
      } else {
        console.warn('No weekly schedule data returned.');
      }
    } catch (e) {
      console.warn('Could not fetch weekly hours:', e.message);
    }

    if (errors.length) console.warn(`\nErrors (${errors.length}):\n`, errors.join('\n'));
    console.log(`\nDone! Inserted ${totalItems} menu items for ${today}. [${new Date().toISOString()}]\n`);
  } finally {
    await browser.close();
  }
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
