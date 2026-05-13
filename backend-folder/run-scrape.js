/**
 * Populate menu data for today + 6 future days, plus weekly hours for all
 * campus dining locations. Idempotent: skips days that already have data
 * unless --force is passed.
 *
 * Crash-proof: if Puppeteer's browser dies mid-run (TargetCloseError, etc.)
 * we relaunch it, re-acquire Cloudflare clearance, and continue from where
 * we left off. Each network request has its own retry loop.
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
const SITE_ID = '5751fd2b90975b60e048929a';
const DAYS_AHEAD = 6;
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function parseNumeric(v) {
  if (v == null || v === '-' || v === '') return null;
  const n = parseFloat(String(v).replace('+', ''));
  return isNaN(n) ? null : n;
}

function getDates() {
  const dates = [];
  for (let i = 0; i <= DAYS_AHEAD; i++) {
    const d = new Date();
    d.setDate(d.getDate() + i);
    dates.push(d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' }));
  }
  return dates;
}

const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const force = process.argv.includes('--force');
console.log(`\n[${new Date().toISOString()}] Scraping menus for today + ${DAYS_AHEAD} days...\n`);

async function clearDate(date) {
  const { data: items } = await supabase.from('menu_items').select('id').eq('date', date);
  if (items?.length) {
    await supabase.from('nutrients').delete().in('menu_item_id', items.map(i => i.id));
  }
  await supabase.from('menu_items').delete().eq('date', date);
  await supabase.from('stations').delete().eq('date', date);
  await supabase.from('periods').delete().eq('date', date);
  await supabase.from('locations').delete().eq('date', date);
}

// ── Resilient browser management ────────────────────────────────────────────
// The browser process can die at any time (network blip, OOM, Cloudflare).
// getBrowser() lazily launches it; if the existing handle is dead, it relaunches
// and re-acquires Cloudflare clearance so subsequent browserGet()s succeed.

let _browser = null;
let _sharedPage = null;

async function launchAndWarm() {
  console.log('  [browser] launching new Chromium...');
  const b = await puppeteer.launch({
    headless: true,
    executablePath: executablePath(),
    protocolTimeout: 60000, // give CDP calls 60s before they fail (default 30s is too tight under load)
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  // Warm-up: load new.dineoncampus.com so Cloudflare issues a clearance cookie.
  // The page returned here is reused for ALL subsequent navigations
  // (much faster + avoids the stealth-plugin overhead of creating new pages 100+ times).
  const page = await b.newPage();
  await page.setUserAgent(USER_AGENT);

  let ok = false;
  for (let i = 0; i < 3 && !ok; i++) {
    try {
      if (i > 0) await new Promise(r => setTimeout(r, 10000));
      await page.goto('https://new.dineoncampus.com/public', {
        waitUntil: 'domcontentloaded', timeout: 90000,
      });
      ok = true;
    } catch (e) {
      console.warn(`  [browser] warm-up attempt ${i + 1} failed: ${e.message}`);
    }
  }
  if (!ok) throw new Error('Failed to load DineOnCampus during warm-up');
  await new Promise(r => setTimeout(r, 4000));

  _sharedPage = page;
  return b;
}

async function getBrowser({ forceRestart = false } = {}) {
  if (forceRestart && _browser) {
    try { await _browser.close(); } catch {}
    _browser = null;
    _sharedPage = null;
  }
  if (!_browser || !_browser.connected) {
    _browser = await launchAndWarm();
  }
  return _browser;
}

function isBrowserDeadError(e) {
  const msg = String(e?.message || '');
  return /Target closed|Protocol error|detached|Connection closed|Browser closed|Session closed|timed out/i.test(msg);
}

// Retry-resilient HTTP via browser navigation, reusing one shared page.
// Restarts browser+page if either dies. ~50× faster than newPage()/close() each time.
async function browserGet(url, { retries = 3 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await getBrowser();
      if (!_sharedPage || _sharedPage.isClosed()) {
        _sharedPage = await _browser.newPage();
        await _sharedPage.setUserAgent(USER_AGENT);
      }
      await _sharedPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      const text = await _sharedPage.evaluate(() => document.body.innerText);
      return JSON.parse(text);
    } catch (e) {
      lastErr = e;
      const dead = isBrowserDeadError(e);
      console.warn(`  [browserGet] attempt ${attempt}/${retries} failed${dead ? ' (browser dead)' : ''}: ${e.message?.slice(0, 120)}`);
      if (dead) {
        try { await getBrowser({ forceRestart: true }); } catch (re) {
          console.warn(`  [browserGet] restart failed: ${re.message}`);
        }
      }
      if (attempt < retries) await new Promise(r => setTimeout(r, 1500 * attempt));
    }
  }
  throw lastErr;
}

async function scrapeDate(date, halls, errors) {
  const { data: existing } = await supabase
    .from('menu_items').select('id').eq('date', date).limit(1);
  const { data: existingLocs } = await supabase
    .from('locations').select('id').eq('date', date).limit(1);
  const hasItems = existing?.length > 0;
  const hasLocs  = existingLocs?.length > 0;

  if (hasItems && hasLocs && !force) {
    console.log(`  ${date}: data exists, skipping`);
    return 0;
  }
  if (hasItems || hasLocs) await clearDate(date);

  let dateTotal = 0;
  for (const hall of halls) {
    let periodsData;
    try {
      periodsData = await browserGet(
        `https://apiv4.dineoncampus.com/locations/${hall.id}/periods/?date=${date}`
      );
    } catch (e) {
      errors.push(`periods ${hall.name} ${date}: ${e.message}`);
      console.warn(`  ${date} ${hall.name}: periods fetch failed after retries`);
      continue;
    }
    const periods = (periodsData?.periods || []).filter(p => p.name !== 'Everyday');
    if (!periods.length) {
      console.log(`  ${date} ${hall.name}: no periods`);
      continue;
    }

    const { data: dbLoc, error: locErr } = await supabase
      .from('locations')
      .insert({ original_id: hall.id, name: hall.name, date })
      .select().single();
    if (locErr) { errors.push(`location ${hall.name} ${date}: ${locErr.message}`); continue; }

    let hallTotal = 0;
    for (const period of periods) {
      const { data: dbPeriod, error: perErr } = await supabase
        .from('periods')
        .insert({ original_id: period.id, location_id: dbLoc.id, name: period.name, date })
        .select().single();
      if (perErr) { errors.push(`period ${period.name} ${date}: ${perErr.message}`); continue; }

      let menuData;
      try {
        menuData = await browserGet(
          `https://apiv4.dineoncampus.com/locations/${hall.id}/menu?date=${date}&period=${period.id}`
        );
      } catch (e) {
        errors.push(`menu ${hall.name}/${period.name} ${date}: ${e.message}`);
        console.warn(`  ${date} ${hall.name}/${period.name}: menu fetch failed after retries`);
        continue;
      }

      if (!menuData?.period?.categories?.length) continue;

      for (const category of menuData.period.categories) {
        const { data: dbStation, error: stErr } = await supabase
          .from('stations')
          .insert({ original_id: category.id ?? null, period_id: dbPeriod.id, name: category.name, date })
          .select().single();
        if (stErr) { errors.push(`station ${category.name} ${date}: ${stErr.message}`); continue; }

        for (const item of (category.items ?? [])) {
          const isVegan       = item.filters?.some(f => f.name === 'Vegan') ?? false;
          const isVegetarian  = item.filters?.some(f => f.name === 'Vegetarian' || f.name === 'Vegan') ?? false;
          const isHighProtein = item.filters?.some(f => f.name === 'Good Source of Protein') ?? false;

          const { data: dbItem, error: itemErr } = await supabase
            .from('menu_items')
            .insert({
              station_id:      dbStation.id,
              original_id:     item.id ?? null,
              name:            item.name,
              calories:        item.calories ?? null,
              portion:         item.portion ?? null,
              date,
              is_vegetarian:   isVegetarian,
              is_vegan:        isVegan,
              is_high_protein: isHighProtein,
            })
            .select().single();
          if (itemErr) { errors.push(`item ${item.name} ${date}: ${itemErr.message}`); continue; }

          if (item.nutrients?.length) {
            const nutrients = item.nutrients.map(n => ({
              menu_item_id:  dbItem.id,
              name:          n.name,
              value:         n.value,
              uom:           n.uom,
              value_numeric: parseNumeric(n.valueNumeric),
            }));
            const { error: nutErr } = await supabase.from('nutrients').insert(nutrients);
            if (nutErr) errors.push(`nutrients for ${item.name} ${date}: ${nutErr.message}`);
          }
          dateTotal++;
          hallTotal++;
        }
      }
    }
    console.log(`  ${date} ${hall.name}: ${hallTotal} items`);
  }
  return dateTotal;
}

async function main() {
  if (process.argv.includes('--background')) {
    console.log('Waiting 60s for network to stabilize...');
    await new Promise(r => setTimeout(r, 60000));
  }

  const dates = getDates();
  console.log(`Dates to scrape: ${dates.join(', ')}\n`);

  const errors = [];

  try {
    // Pre-warm the browser so the first browserGet doesn't pay the launch cost.
    await getBrowser();

    let halls = [];
    try {
      const locsData = await browserGet(
        `https://apiv4.dineoncampus.com/sites/${SITE_ID}/locations-public?for_menus=true`
      );
      const flat = (locsData?.buildings || []).flatMap(b => b.locations || []);
      halls = flat.filter(l => ALLOWED_HALLS.some(n => l.name?.includes(n)));
    } catch (e) {
      console.error('locations-public fetch failed:', e.message);
    }

    if (!halls.length) {
      console.log('No matching dining halls found. Exiting.');
      return;
    }

    console.log(`\nFound ${halls.length} matching halls: ${halls.map(h => h.name).join(', ')}\n`);

    let grandTotal = 0;
    for (const date of dates) {
      console.log(`\n── ${date} ──`);
      try {
        grandTotal += await scrapeDate(date, halls, errors);
      } catch (e) {
        // scrapeDate handles its own per-hall failures, but if something
        // unexpected escapes, log and keep going to next date.
        errors.push(`scrapeDate ${date}: ${e.message}`);
        console.warn(`  ${date}: unexpected error, continuing — ${e.message}`);
      }
    }

    await supabase.from('steast_vs_iv')
      .upsert({ date: today, steast: 0, iv: 0 }, { onConflict: 'date', ignoreDuplicates: true });

    // ── Weekly hours for all 31 campus locations ───────────────────────────
    console.log('\nFetching weekly hours...');
    try {
      const scheduleData = await browserGet(
        `https://apiv4.dineoncampus.com/locations/weekly_schedule?site_id=${SITE_ID}&date=${today}`
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
        console.log(`Updated hours: ${hoursCount} location-days across ${scheduleData.theLocations.length} locations.`);
      } else {
        console.warn('No weekly schedule data returned.');
      }
    } catch (e) {
      console.warn('Could not fetch weekly hours:', e.message);
    }

    if (errors.length) console.warn(`\nErrors (${errors.length}):\n`, errors.slice(0, 30).join('\n'));
    console.log(`\nDone! Inserted ${grandTotal} menu items across ${dates.length} days. [${new Date().toISOString()}]\n`);
  } finally {
    if (_browser) { try { await _browser.close(); } catch {} }
  }
}

main().catch(err => {
  // Top-level safety net: log fatal but exit 0 so launchd doesn't see it as a hard failure.
  // Any data already committed up to this point is safe in Supabase.
  console.error('Fatal:', err.message);
  if (_browser) { try { _browser.close(); } catch {} }
  process.exit(0);
});
