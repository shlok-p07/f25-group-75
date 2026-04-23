/**
 * Vercel Cron Handler — runs daily at 8 AM UTC (3-4 AM ET)
 * Fetches today's menu from the DineOnCampus public API and upserts into Supabase.
 * No Puppeteer / Chrome needed — plain fetch calls.
 */

import { createClient } from '@supabase/supabase-js';

function parseNumeric(v) {
  if (v == null || v === '-' || v === '') return null;
  const n = parseFloat(String(v).replace('+', ''));
  return isNaN(n) ? null : n;
}

const SITE_ID = '5751fd2b90975b60e048929a';
const DINE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Referer': 'https://dineoncampus.com/',
  'Origin': 'https://dineoncampus.com',
  'sec-fetch-dest': 'empty',
  'sec-fetch-mode': 'cors',
  'sec-fetch-site': 'same-site',
};

export default async function handler(req, res) {
  // Vercel sends Authorization: Bearer <CRON_SECRET> for cron invocations.
  // Also allow manual POST with the same header for testing.
  const authHeader = req.headers.authorization ?? '';
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  console.log(`[scrape] Starting scrape for ${today}`);

  // Skip if data already exists for today
  const { data: existing } = await supabase
    .from('menu_items')
    .select('id')
    .eq('date', today)
    .limit(1);

  if (existing && existing.length > 0) {
    console.log(`[scrape] Data already exists for ${today}, skipping.`);
    return res.json({ message: `Menu data already exists for ${today}`, skipped: true });
  }

  // 1. Fetch top-level locations (with periods + stations + basic items)
  let locationsData;
  try {
    const locRes = await fetch(
      `https://api.dineoncampus.com/v1/sites/${SITE_ID}/locations?date=${today}`,
      { headers: DINE_HEADERS }
    );
    if (!locRes.ok) throw new Error(`Locations API ${locRes.status}`);
    locationsData = await locRes.json();
  } catch (err) {
    console.error('[scrape] Failed to fetch locations:', err.message);
    // Try without date param as fallback
    try {
      const locRes2 = await fetch(
        `https://api.dineoncampus.com/v1/sites/${SITE_ID}/locations`,
        { headers: DINE_HEADERS }
      );
      locationsData = await locRes2.json();
    } catch (err2) {
      return res.status(502).json({ error: 'Failed to reach DineOnCampus API', detail: err2.message });
    }
  }

  if (!locationsData?.locations?.length) {
    return res.status(404).json({ error: 'DineOnCampus returned no locations', raw: locationsData });
  }

  let totalItems = 0;
  const errors = [];

  for (const loc of locationsData.locations) {
    // Only process the 3 main halls
    const allowedNames = ['Stetson East', 'International Village', '60 Belvidere'];
    if (!allowedNames.some(n => loc.name?.includes(n.split(' ')[0]))) continue;

    console.log(`[scrape] Processing location: ${loc.name}`);

    // Insert location
    const { data: dbLoc, error: locInsErr } = await supabase
      .from('locations')
      .insert({ original_id: loc.id, name: loc.name, type: loc.type, building_name: loc.building_name, sort_order: loc.sort_order, date: today })
      .select()
      .single();

    if (locInsErr) { errors.push(`location ${loc.name}: ${locInsErr.message}`); continue; }

    for (const period of (loc.periods ?? [])) {
      const { data: dbPeriod, error: perInsErr } = await supabase
        .from('periods')
        .insert({ original_id: period.id, location_id: dbLoc.id, name: period.name, date: today })
        .select()
        .single();

      if (perInsErr) { errors.push(`period ${period.name}: ${perInsErr.message}`); continue; }

      // 2. Fetch detailed menu for this period (nutrients + filters)
      let detailed = null;
      try {
        const detailRes = await fetch(
          `https://apiv4.dineoncampus.com/locations/${loc.id}/menu?date=${today}&period=${period.id}`,
          { headers: DINE_HEADERS }
        );
        if (detailRes.ok) detailed = await detailRes.json();
      } catch (e) {
        console.warn(`[scrape] Could not fetch details for period ${period.id}:`, e.message);
      }

      // Build name → detailed item map
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
          .select()
          .single();

        if (stInsErr) { errors.push(`station ${station.name}: ${stInsErr.message}`); continue; }

        for (const item of (station.items ?? [])) {
          const d = detailMap.get(item.name);
          const isVegan = d?.filters?.some(f => f.name === 'Vegan') ?? false;
          const isVegetarian = d?.filters?.some(f => f.name === 'Vegetarian' || f.name === 'Vegan') ?? false;
          const isHighProtein = d?.filters?.some(f => f.name === 'Good Source of Protein') ?? false;

          const { data: dbItem, error: itemInsErr } = await supabase
            .from('menu_items')
            .insert({
              station_id: dbStation.id,
              original_id: d?.id ?? null,
              name: item.name,
              calories: item.calories ?? null,
              portion: item.portion ?? null,
              date: today,
              is_vegetarian: isVegetarian,
              is_vegan: isVegan,
              is_high_protein: isHighProtein,
            })
            .select()
            .single();

          if (itemInsErr) { errors.push(`item ${item.name}: ${itemInsErr.message}`); continue; }

          // Insert nutrients
          if (d?.nutrients?.length) {
            const nutrients = d.nutrients.map(n => ({
              menu_item_id: dbItem.id,
              name: n.name,
              value: n.value,
              uom: n.uom,
              value_numeric: parseNumeric(n.valueNumeric),
            }));
            const { error: nutErr } = await supabase.from('nutrients').insert(nutrients);
            if (nutErr) errors.push(`nutrients for ${item.name}: ${nutErr.message}`);
          }

          totalItems++;
        }
      }
    }
  }

  // Ensure today's vote row exists
  await supabase
    .from('steast_vs_iv')
    .upsert({ date: today, steast: 0, iv: 0 }, { onConflict: 'date', ignoreDuplicates: true });

  console.log(`[scrape] Done. ${totalItems} items inserted. ${errors.length} errors.`);
  return res.json({
    date: today,
    totalItems,
    errors: errors.length ? errors : undefined,
    ok: true,
  });
}
