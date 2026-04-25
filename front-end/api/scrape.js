/**
 * Vercel Cron Handler — runs daily at 8 AM UTC (3-4 AM ET)
 * Fetches today's menu from apiv4.dineoncampus.com and upserts into Supabase.
 * Uses apiv4 (not api.dineoncampus.com/v1 which is Cloudflare-blocked from serverless).
 *
 * All per-period API calls run in parallel to stay within Vercel's execution limit.
 */

import { createClient } from '@supabase/supabase-js';

function parseNumeric(v) {
  if (v == null || v === '-' || v === '') return null;
  const n = parseFloat(String(v).replace('+', ''));
  return isNaN(n) ? null : n;
}

const ALLOWED_HALLS = ['Stetson', 'International', 'Belvidere'];

const DINE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://dineoncampus.com/',
  'Origin': 'https://dineoncampus.com',
  'sec-fetch-dest': 'empty',
  'sec-fetch-mode': 'cors',
  'sec-fetch-site': 'same-site',
};

async function apiv4Get(url) {
  const res = await fetch(url, { headers: DINE_HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  const text = await res.text();
  if (!text.trim().startsWith('{') && !text.trim().startsWith('[')) {
    throw new Error(`Non-JSON from ${url}: ${text.slice(0, 120)}`);
  }
  return JSON.parse(text);
}

export default async function handler(req, res) {
  const authHeader = req.headers.authorization ?? '';
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const force = req.query.force === 'true';

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  console.log(`[scrape] Starting scrape for ${today}`);

  const [{ data: existing }, { data: existingLocs }] = await Promise.all([
    supabase.from('menu_items').select('id').eq('date', today).limit(1),
    supabase.from('locations').select('id').eq('date', today).limit(1),
  ]);

  const hasItems = existing?.length > 0;
  const hasLocs  = existingLocs?.length > 0;

  if (hasItems && hasLocs && !force) {
    console.log(`[scrape] Data already exists for ${today}, skipping.`);
    return res.json({ message: `Menu data already exists for ${today}`, skipped: true });
  }

  if (hasItems || hasLocs) {
    console.log(`[scrape] Clearing partial/stale data for ${today}...`);
    const itemIds = (existing || []).map(i => i.id);
    await Promise.all([
      itemIds.length ? supabase.from('nutrients').delete().in('menu_item_id', itemIds) : Promise.resolve(),
      supabase.from('menu_items').delete().eq('date', today),
      supabase.from('stations').delete().eq('date', today),
      supabase.from('periods').delete().eq('date', today),
      supabase.from('locations').delete().eq('date', today),
    ]);
  }

  let rawLocations;
  try {
    const data = await apiv4Get('https://apiv4.dineoncampus.com/sites/todays_menu');
    rawLocations = data?.locations;
  } catch (err) {
    console.error('[scrape] Failed to fetch todays_menu:', err.message);
    return res.status(502).json({ error: 'Failed to reach DineOnCampus API', detail: err.message });
  }

  const allowed = (rawLocations || []).filter(l => ALLOWED_HALLS.some(n => l.name?.includes(n)));
  if (!allowed.length) {
    return res.status(404).json({ error: 'No matching dining halls found in todays_menu' });
  }

  const errors = [];
  let totalItems = 0;

  // Insert locations, then fan out period fetches in parallel per location
  await Promise.all(allowed.map(async (loc) => {
    const { data: dbLoc, error: locErr } = await supabase
      .from('locations')
      .insert({ original_id: loc.id, name: loc.name, date: today })
      .select().single();
    if (locErr) { errors.push(`location ${loc.name}: ${locErr.message}`); return; }

    const periods = (loc.periods ?? []).filter(p => p.name !== 'Everyday');

    // Fetch all period menus in parallel for this location
    await Promise.all(periods.map(async (period) => {
      const { data: dbPeriod, error: perErr } = await supabase
        .from('periods')
        .insert({ original_id: period.id, location_id: dbLoc.id, name: period.name, date: today })
        .select().single();
      if (perErr) { errors.push(`period ${period.name}: ${perErr.message}`); return; }

      let menuData = null;
      try {
        menuData = await apiv4Get(
          `https://apiv4.dineoncampus.com/locations/${loc.id}/menu?date=${today}&period=${period.id}`
        );
      } catch (e) {
        console.warn(`[scrape] Menu fetch failed for ${period.name}:`, e.message);
        return;
      }

      if (!menuData?.period?.categories?.length) return;

      for (const category of menuData.period.categories) {
        const { data: dbStation, error: stErr } = await supabase
          .from('stations')
          .insert({ original_id: category.id ?? null, period_id: dbPeriod.id, name: category.name, date: today })
          .select().single();
        if (stErr) { errors.push(`station ${category.name}: ${stErr.message}`); continue; }

        const items = category.items ?? [];

        // Batch-insert all items for this station in one call
        if (!items.length) continue;
        const itemRows = items.map(item => ({
          station_id:      dbStation.id,
          original_id:     item.id ?? null,
          name:            item.name,
          calories:        item.calories ?? null,
          portion:         item.portion ?? null,
          date:            today,
          is_vegetarian:   item.filters?.some(f => f.name === 'Vegetarian' || f.name === 'Vegan') ?? false,
          is_vegan:        item.filters?.some(f => f.name === 'Vegan') ?? false,
          is_high_protein: item.filters?.some(f => f.name === 'Good Source of Protein') ?? false,
        }));

        const { data: dbItems, error: itemsErr } = await supabase
          .from('menu_items').insert(itemRows).select('id, original_id');
        if (itemsErr) { errors.push(`items for ${category.name}: ${itemsErr.message}`); continue; }

        totalItems += dbItems.length;

        // Batch-insert all nutrients across all items in this station
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
          if (nutErr) errors.push(`nutrients for ${category.name}: ${nutErr.message}`);
        }

        console.log(`[scrape] ${loc.name} / ${period.name} / ${category.name}: ${items.length} items`);
      }
    }));
  }));

  await supabase.from('steast_vs_iv')
    .upsert({ date: today, steast: 0, iv: 0 }, { onConflict: 'date', ignoreDuplicates: true });

  console.log(`[scrape] Done. ${totalItems} items. ${errors.length} errors.`);
  return res.json({ date: today, totalItems, errors: errors.length ? errors : undefined, ok: true });
}
