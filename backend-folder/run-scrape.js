/**
 * Populate today's menu data including nutrients and dietary filters.
 *
 *   cd backend-folder
 *   node run-scrape.js           # normal run
 *   node run-scrape.js --force   # clear today's data and re-scrape
 *
 * Calls apiv4.dineoncampus.com directly via fetch (server-side, no CORS restriction).
 * apiv4 works without Cloudflare bypass; api.dineoncampus.com/v1 does not.
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

function parseNumeric(v) {
  if (v == null || v === '-' || v === '') return null;
  const n = parseFloat(String(v).replace('+', ''));
  return isNaN(n) ? null : n;
}

async function apiv4Get(url) {
  const res = await fetch(url, { headers: DINE_HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  const text = await res.text();
  if (!text.trim().startsWith('{') && !text.trim().startsWith('[')) {
    throw new Error(`Non-JSON from ${url}: ${text.slice(0, 120)}`);
  }
  return JSON.parse(text);
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

async function main() {
  const { data: existing } = await supabase
    .from('menu_items').select('id').eq('date', today).limit(1);
  const { data: existingLocs } = await supabase
    .from('locations').select('id').eq('date', today).limit(1);

  const hasItems = existing?.length > 0;
  const hasLocs  = existingLocs?.length > 0;
  const isComplete = hasItems && hasLocs;

  if (isComplete && !force) {
    console.log(`Menu data already exists for ${today}. Use --force to re-scrape.`);
    return;
  }

  if (hasItems || hasLocs) {
    if (!isComplete) {
      console.log(`Partial data found for ${today} (items=${hasItems}, locations=${hasLocs}) — clearing and re-scraping...`);
    }
    await clearToday();
  }

  let locations;
  try {
    const data = await apiv4Get('https://apiv4.dineoncampus.com/sites/todays_menu');
    locations = data?.locations;
  } catch (err) {
    console.error('Failed to fetch todays_menu:', err.message);
    process.exit(1);
  }

  if (!locations?.length) {
    console.error('DineOnCampus returned no locations');
    process.exit(1);
  }

  console.log(`Found ${locations.length} locations total.\n`);

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

      let menuData = null;
      try {
        menuData = await apiv4Get(
          `https://apiv4.dineoncampus.com/locations/${loc.id}/menu?date=${today}&period=${period.id}`
        );
      } catch (e) {
        console.warn(`  Could not fetch menu for period ${period.id}:`, e.message);
      }

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
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
