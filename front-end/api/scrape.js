/**
 * Vercel Cloud Scraper — secondary path, kept mainly as a Supabase heartbeat.
 *
 * apiv4.dineoncampus.com blocks datacenter IPs behind Cloudflare — confirmed against
 * Vercel itself and against plain GitHub-hosted Actions runners (see git history on
 * .github/workflows/daily-scrape.yml). Without a residential proxy (ZenRows or similar)
 * this can never reach DineOnCampus from here, so if ZENROWS_KEY isn't set we skip the
 * scrape attempt entirely rather than retry-and-fail against Cloudflare every day.
 *
 * The real scraper is backend-folder/run-scrape.js, run via launchd on a Mac with a
 * residential IP (com.nudining.scrape.plist, 8x/day). This endpoint's job is just to
 * touch Supabase daily so the free-tier project doesn't auto-pause from inactivity.
 *
 * Endpoints used (matches new.dineoncampus.com), if ZENROWS_KEY is configured:
 *   /sites/{SITE_ID}/locations-public?for_menus=true   — hall list
 *   /locations/{id}/periods/?date={date}                — periods per date
 *   /locations/{id}/menu?date={date}&period={periodId}  — menu items
 *   /locations/weekly_schedule?site_id={SITE_ID}&date=  — weekly hours
 */

import { createClient } from '@supabase/supabase-js';

const ALLOWED_HALLS = ['Stetson', 'International', 'Belvidere'];
const SITE_ID = '5751fd2b90975b60e048929a';
// DineOnCampus publishes menus weeks/months out. Scrape a large forward window so a
// multi-day scraper outage (Cloudflare block, proxy quota, etc.) doesn't leave upcoming
// days with no menu at all — there's already a buffer of previously-scraped future dates.
const DAYS_AHEAD = 29;
// Cap how many *not-yet-complete* dates get (re)scraped per invocation. Without this, a
// large window (or catching up after an outage) could try to scrape dozens of dates in
// one 300s function call, risking a timeout and burning the whole monthly ZenRows quota
// in one run. Capping means catch-up happens gradually across several daily runs instead.
const MAX_DATES_PER_RUN = 6;

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

// HTTP GET through ZenRows residential proxy (bypasses Cloudflare).
// Falls back to direct fetch if no key is set (will fail from Vercel IPs).
async function apiGet(url, { retries = 3 } = {}) {
  const zenrowsKey = process.env.ZENROWS_KEY;
  let lastErr;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      let target;
      if (zenrowsKey) {
        const proxy = new URL('https://api.zenrows.com/v1/');
        proxy.searchParams.set('apikey', zenrowsKey);
        proxy.searchParams.set('url', url);
        proxy.searchParams.set('custom_headers', 'true');
        target = proxy.toString();
      } else {
        target = url;
      }
      const res = await fetch(target, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          'Accept': 'application/json, text/plain, */*',
          'Referer': 'https://new.dineoncampus.com/',
          'Origin': 'https://new.dineoncampus.com',
        },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
      const text = await res.text();
      if (!text.trim().startsWith('{') && !text.trim().startsWith('[')) {
        throw new Error(`Non-JSON from ${url}: ${text.slice(0, 100)}`);
      }
      return JSON.parse(text);
    } catch (e) {
      lastErr = e;
      if (attempt < retries) await new Promise(r => setTimeout(r, 1200 * attempt));
    }
  }
  throw lastErr;
}

async function clearDate(supabase, date) {
  const { data: items } = await supabase.from('menu_items').select('id').eq('date', date);
  if (items?.length) {
    await supabase.from('nutrients').delete().in('menu_item_id', items.map(i => i.id));
  }
  // Sequential: child → parent (FK cascade also handles it but explicit is safer)
  await supabase.from('menu_items').delete().eq('date', date);
  await supabase.from('stations').delete().eq('date', date);
  await supabase.from('periods').delete().eq('date', date);
  await supabase.from('locations').delete().eq('date', date);
}

async function scrapeDate(supabase, date, halls, force, errors) {
  if (!force) {
    const { data: status } = await supabase
      .from('scrape_status').select('complete').eq('date', date).maybeSingle();
    if (status?.complete) return null; // already fully scraped — doesn't count against the per-run cap
  }

  const { data: existingLocs } = await supabase
    .from('locations').select('id').eq('date', date).limit(1);
  if (existingLocs?.length) await clearDate(supabase, date);

  const errorsBefore = errors.length;
  let dateTotal = 0;
  try {
  for (const hall of halls) {
    let periodsData;
    try {
      periodsData = await apiGet(`https://apiv4.dineoncampus.com/locations/${hall.id}/periods/?date=${date}`);
    } catch (e) {
      errors.push(`periods ${hall.name} ${date}: ${e.message}`);
      continue;
    }
    const periods = (periodsData?.periods || []).filter(p => p.name !== 'Everyday');
    if (!periods.length) continue;

    const { data: dbLoc, error: locErr } = await supabase
      .from('locations')
      .insert({ original_id: hall.id, name: hall.name, date })
      .select().single();
    if (locErr) { errors.push(`location ${hall.name} ${date}: ${locErr.message}`); continue; }

    for (const period of periods) {
      const { data: dbPeriod, error: perErr } = await supabase
        .from('periods')
        .insert({ original_id: period.id, location_id: dbLoc.id, name: period.name, date })
        .select().single();
      if (perErr) { errors.push(`period ${period.name} ${date}: ${perErr.message}`); continue; }

      let menuData;
      try {
        menuData = await apiGet(
          `https://apiv4.dineoncampus.com/locations/${hall.id}/menu?date=${date}&period=${period.id}`
        );
      } catch (e) {
        errors.push(`menu ${hall.name}/${period.name} ${date}: ${e.message}`);
        continue;
      }

      if (!menuData?.period?.categories?.length) continue;

      for (const category of menuData.period.categories) {
        const { data: dbStation, error: stErr } = await supabase
          .from('stations')
          .insert({ original_id: category.id ?? null, period_id: dbPeriod.id, name: category.name, date })
          .select().single();
        if (stErr) { errors.push(`station ${category.name} ${date}: ${stErr.message}`); continue; }

        const items = category.items ?? [];
        if (!items.length) continue;

        const itemRows = items.map(item => ({
          station_id:      dbStation.id,
          original_id:     item.id ?? null,
          name:            item.name,
          calories:        item.calories ?? null,
          portion:         item.portion ?? null,
          date,
          is_vegetarian:   item.filters?.some(f => f.name === 'Vegetarian' || f.name === 'Vegan') ?? false,
          is_vegan:        item.filters?.some(f => f.name === 'Vegan') ?? false,
          is_high_protein: item.filters?.some(f => f.name === 'Good Source of Protein') ?? false,
        }));

        const { data: dbItems, error: itemsErr } = await supabase
          .from('menu_items').insert(itemRows).select('id, original_id');
        if (itemsErr) { errors.push(`items ${category.name} ${date}: ${itemsErr.message}`); continue; }

        dateTotal += dbItems.length;

        const nutrients = [];
        for (const dbItem of (dbItems || [])) {
          const raw = items.find(i => (i.id ?? null) === dbItem.original_id);
          for (const n of (raw?.nutrients ?? [])) {
            nutrients.push({
              menu_item_id:  dbItem.id,
              name:          n.name,
              value:         n.value,
              uom:           n.uom,
              value_numeric: parseNumeric(n.valueNumeric),
            });
          }
        }
        if (nutrients.length) {
          const { error: nutErr } = await supabase.from('nutrients').insert(nutrients);
          if (nutErr) errors.push(`nutrients ${category.name} ${date}: ${nutErr.message}`);
        }
      }
    }
  }
  } catch (e) {
    // Ensures the scrape_status upsert below still runs even on an unexpected throw —
    // otherwise a stale "complete" row from a prior success would wrongly cause this
    // date to be skipped forever on future runs, despite clearDate() already having
    // wiped its data above.
    errors.push(`date ${date}: ${e.message}`);
  }

  const dateErrors = errors.slice(errorsBefore);
  await supabase.from('scrape_status').upsert({
    date,
    complete: dateErrors.length === 0,
    error_count: dateErrors.length,
    last_errors: dateErrors,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'date' });

  return dateTotal;
}

export default async function handler(req, res) {
  // CRON_SECRET protects against arbitrary external calls (Vercel injects this for crons)
  const authHeader = req.headers.authorization ?? '';
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const force = req.query.force === 'true';
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const dates = getDates();
  const today = dates[0];
  console.log(`[cloud-scrape] starting for dates: ${dates.join(', ')}`);

  // Heartbeat: touch the DB before anything that can fail downstream (ZenRows/Cloudflare).
  // Free-tier Supabase projects auto-pause after 7 days with zero API activity — if the
  // scrape below throws before reaching a query, this guarantees the cron still counts
  // as activity every day it runs, regardless of whether scraping itself succeeds.
  try {
    await supabase.from('locations').select('id').limit(1);
  } catch (e) {
    console.error('[cloud-scrape] heartbeat query failed:', e.message);
  }

  // Without a residential proxy, every request here gets Cloudflare-blocked — don't
  // bother retrying against it daily. See file header for why.
  if (!process.env.ZENROWS_KEY) {
    console.log('[cloud-scrape] ZENROWS_KEY not set — skipping scrape attempt, heartbeat only.');
    return res.json({
      ok: true,
      heartbeatOnly: true,
      reason: 'ZENROWS_KEY not configured; DineOnCampus is Cloudflare-blocked from Vercel without a residential proxy. Scraping runs via backend-folder/run-scrape.js on a local Mac instead.',
    });
  }

  // 1. Get hall list
  let halls = [];
  try {
    const locsData = await apiGet(`https://apiv4.dineoncampus.com/sites/${SITE_ID}/locations-public?for_menus=true`);
    const flat = (locsData?.buildings || []).flatMap(b => b.locations || []);
    halls = flat.filter(l => ALLOWED_HALLS.some(n => l.name?.includes(n)));
  } catch (e) {
    console.error('[cloud-scrape] locations-public failed:', e.message);
    return res.status(502).json({ error: 'Failed to reach DineOnCampus', detail: e.message });
  }
  if (!halls.length) return res.status(404).json({ error: 'No matching halls found' });

  console.log(`[cloud-scrape] ${halls.length} halls: ${halls.map(h => h.name).join(', ')}`);

  // 2. Scrape menus per date — soonest dates first, capped per run (see MAX_DATES_PER_RUN)
  const errors = [];
  let grandTotal = 0;
  let scrapedCount = 0;
  for (const date of dates) {
    if (scrapedCount >= MAX_DATES_PER_RUN) break;
    try {
      const count = await scrapeDate(supabase, date, halls, force, errors);
      if (count === null) continue; // already complete, didn't count against the cap
      scrapedCount++;
      grandTotal += count;
      console.log(`[cloud-scrape] ${date}: ${count} items`);
    } catch (e) {
      errors.push(`date ${date}: ${e.message}`);
    }
  }

  // 3. Weekly hours for all campus locations
  try {
    const scheduleData = await apiGet(
      `https://apiv4.dineoncampus.com/locations/weekly_schedule?site_id=${SITE_ID}&date=${today}`
    );
    let hoursCount = 0;
    for (const loc of (scheduleData?.theLocations || [])) {
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
      }
    }
    console.log(`[cloud-scrape] hours: ${hoursCount} location-days updated`);
  } catch (e) {
    errors.push(`weekly_schedule: ${e.message}`);
  }

  await supabase.from('steast_vs_iv')
    .upsert({ date: today, steast: 0, iv: 0 }, { onConflict: 'date', ignoreDuplicates: true });

  console.log(`[cloud-scrape] done — ${grandTotal} items, ${errors.length} errors`);
  return res.json({
    ok: true,
    dates,
    totalItems: grandTotal,
    halls: halls.map(h => h.name),
    errors: errors.length ? errors.slice(0, 20) : undefined,
  });
}
