/**
 * Populate today's menu data.
 *
 *   cd backend-folder
 *   node run-scrape.js
 *
 * Uses the DineOnCampus v1 public API (plain fetch, no Puppeteer required).
 */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('ERROR: Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in backend-folder/.env');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const SITE_ID = '5751fd2b90975b60e048929a';
const DINE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept': 'application/json',
};

const ALLOWED_HALLS = ['Stetson', 'International', 'Belvidere'];

const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
console.log(`Scraping menu data for ${today}...\n`);

async function main() {
  // Skip if already populated
  const { data: existing } = await supabase
    .from('menu_items').select('id').eq('date', today).limit(1);
  if (existing && existing.length > 0) {
    console.log(`Menu data already exists for ${today}. Nothing to do.`);
    return;
  }

  // 1. Fetch locations with periods/stations/items from v1 API
  let locationsData;
  try {
    const res = await fetch(
      `https://api.dineoncampus.com/v1/sites/${SITE_ID}/locations?date=${today}`,
      { headers: DINE_HEADERS }
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    locationsData = await res.json();
  } catch (err) {
    console.error('Failed to fetch locations:', err.message);
    process.exit(1);
  }

  if (!locationsData?.locations?.length) {
    console.error('DineOnCampus returned no locations:', JSON.stringify(locationsData));
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

      // 2. Fetch detailed menu (nutrients/filters) — optional, best-effort
      let detailMap = new Map();
      try {
        const detailRes = await fetch(
          `https://apiv4.dineoncampus.com/locations/${loc.id}/menu?date=${today}&period=${period.id}`,
          { headers: DINE_HEADERS }
        );
        if (detailRes.ok) {
          const detailed = await detailRes.json();
          for (const cat of (detailed?.period?.categories ?? [])) {
            for (const item of (cat.items ?? [])) {
              detailMap.set(item.name, item);
            }
          }
        }
      } catch (e) {
        // Detail fetch is optional — proceed without it
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
              station_id:      dbStation.id,
              original_id:     d?.id ?? null,
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

          if (d?.nutrients?.length) {
            await supabase.from('nutrients').insert(
              d.nutrients.map(n => ({
                menu_item_id:  dbItem.id,
                name:          n.name,
                value:         n.value,
                uom:           n.uom,
                value_numeric: parseFloat(n.valueNumeric) || null,
              }))
            );
          }
          totalItems++;
        }
        console.log(`  ${period.name} / ${station.name}: ${station.items?.length || 0} items`);
      }
    }
  }

  // Ensure today's vote row exists
  await supabase.from('steast_vs_iv')
    .upsert({ date: today, steast: 0, iv: 0 }, { onConflict: 'date', ignoreDuplicates: true });

  if (errors.length) console.warn(`\nErrors (${errors.length}):\n`, errors.join('\n'));
  console.log(`\nDone! Inserted ${totalItems} menu items for ${today}.`);
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
