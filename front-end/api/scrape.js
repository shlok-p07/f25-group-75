/**
 * Vercel Cron Handler — runs daily at 8 AM UTC (3-4 AM ET)
 * Fetches today's menu from apiv4.dineoncampus.com and upserts into Supabase.
 * Uses apiv4 (not api.dineoncampus.com/v1 which is Cloudflare-blocked from serverless).
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

  const { data: existing } = await supabase
    .from('menu_items').select('id').eq('date', today).limit(1);
  const { data: existingLocs } = await supabase
    .from('locations').select('id').eq('date', today).limit(1);

  const hasItems = existing?.length > 0;
  const hasLocs  = existingLocs?.length > 0;
  const isComplete = hasItems && hasLocs;

  if (isComplete && !force) {
    console.log(`[scrape] Data already exists for ${today}, skipping.`);
    return res.json({ message: `Menu data already exists for ${today}`, skipped: true });
  }

  // Respond immediately so callers (e.g. GitHub Actions curl) don't time out
  // waiting for the full scrape. Vercel keeps the function alive up to maxDuration.
  res.status(202).json({ message: 'Scrape started', date: today });

  if (hasItems || hasLocs) {
    console.log(`[scrape] Partial or stale data found (items=${hasItems}, locations=${hasLocs}) — clearing...`);
    if (existing?.length) {
      const ids = existing.map(i => i.id);
      await supabase.from('nutrients').delete().in('menu_item_id', ids);
    }
    await supabase.from('menu_items').delete().eq('date', today);
    await supabase.from('stations').delete().eq('date', today);
    await supabase.from('periods').delete().eq('date', today);
    await supabase.from('locations').delete().eq('date', today);
  }

  let locations;
  try {
    const data = await apiv4Get('https://apiv4.dineoncampus.com/sites/todays_menu');
    locations = data?.locations;
  } catch (err) {
    console.error('[scrape] Failed to fetch todays_menu:', err.message);
    return;
  }

  if (!locations?.length) {
    console.error('[scrape] DineOnCampus returned no locations');
    return;
  }

  let totalItems = 0;
  const errors = [];

  for (const loc of locations) {
    if (!ALLOWED_HALLS.some(n => loc.name?.includes(n))) continue;
    console.log(`[scrape] Processing: ${loc.name}`);

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

      let menuData = null;
      try {
        menuData = await apiv4Get(
          `https://apiv4.dineoncampus.com/locations/${loc.id}/menu?date=${today}&period=${period.id}`
        );
      } catch (e) {
        console.warn(`[scrape] Could not fetch menu for period ${period.id}:`, e.message);
      }

      if (!menuData?.period?.categories?.length) {
        console.log(`[scrape]   ${period.name}: no categories`);
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
        console.log(`[scrape]   ${period.name} / ${category.name}: ${category.items?.length || 0} items`);
      }
    }
  }

  await supabase
    .from('steast_vs_iv')
    .upsert({ date: today, steast: 0, iv: 0 }, { onConflict: 'date', ignoreDuplicates: true });

  console.log(`[scrape] Done. ${totalItems} items inserted. ${errors.length} errors.`);
}
