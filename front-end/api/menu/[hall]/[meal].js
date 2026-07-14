import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const HALL_KEYWORD = {
  'stetson-east':          'Stetson',
  'steast':                'Stetson',
  'international-village': 'International',
  'iv':                    'International',
  '60-belvidere':          'Belvidere',
  'belvidere':             'Belvidere',
};

function mapHall(slug) {
  return HALL_KEYWORD[slug.toLowerCase()] ?? slug;
}

function mapMeal(slug) {
  return {
    'breakfast': 'Breakfast',
    'lunch': 'Lunch',
    'dinner': 'Dinner',
    'brunch': 'Brunch',
  }[slug.toLowerCase()] ?? slug;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const { hall, meal, date: dateParam } = req.query;
  const locationKeyword = mapHall(hall);
  const periodName = mapMeal(meal);
  const locationPattern = `%${locationKeyword}%`;

  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  // If a specific date is requested, use only that date (no fallback).
  // Otherwise default to today, then fall FORWARD to the nearest upcoming day
  // that actually has this meal (menus are pre-loaded ~a week ahead), and only
  // fall back to recent past days as a last resort.
  const isExplicitDate = typeof dateParam === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateParam);

  // 1. Build the ordered list of candidate dates to try.
  let candidateDates;
  if (isExplicitDate) {
    candidateDates = [dateParam];
  } else {
    const [{ data: upcoming }, { data: past }] = await Promise.all([
      supabase
        .from('locations')
        .select('date')
        .ilike('name', locationPattern)
        .gte('date', today)
        .order('date', { ascending: true })
        .limit(21),
      supabase
        .from('locations')
        .select('date')
        .ilike('name', locationPattern)
        .lt('date', today)
        .order('date', { ascending: false })
        .limit(21),
    ]);
    const seen = new Set();
    candidateDates = [];
    // today + upcoming first (ascending), then most-recent past (descending)
    for (const row of [...(upcoming ?? []), ...(past ?? [])]) {
      if (!seen.has(row.date)) { seen.add(row.date); candidateDates.push(row.date); }
    }
  }

  if (candidateDates.length === 0) {
    return res.status(404).json({
      error: 'hall_closed',
      message: `No data found for ${locationKeyword}.`,
    });
  }

  // 2. Use the first candidate date that has this location + period + stations.
  let location = null;
  let period = null;
  let dateToUse = null;

  for (const d of candidateDates) {
    const { data: locs, error: locErr } = await supabase
      .from('locations')
      .select('id, name, date')
      .ilike('name', locationPattern)
      .eq('date', d);
    if (locErr) return res.status(500).json({ error: locErr.message });
    if (!locs || locs.length === 0) continue;

    for (const loc of locs) {
      const { data: periods } = await supabase
        .from('periods')
        .select('id, name, date')
        .eq('location_id', loc.id)
        .eq('name', periodName)
        .eq('date', d);

      if (!periods || periods.length === 0) continue;

      for (const p of periods) {
        const { data: stationCheck } = await supabase
          .from('stations')
          .select('id')
          .eq('period_id', p.id)
          .eq('date', d)
          .limit(1);

        if (stationCheck && stationCheck.length > 0) {
          location = loc;
          period = p;
          dateToUse = d;
          break;
        }
      }
      if (period) break;
    }
    if (period) break;
  }

  if (!period) {
    return res.status(404).json({
      error: 'meal_not_posted',
      message: `No ${periodName} menu found for ${locationKeyword}.`,
    });
  }

  // 3. Get stations
  const { data: stations, error: stErr } = await supabase
    .from('stations')
    .select('id, name')
    .eq('period_id', period.id)
    .eq('date', dateToUse);

  if (stErr) return res.status(500).json({ error: stErr.message });
  if (!stations || stations.length === 0) {
    return res.json({ location: location.name, period: period.name, date: dateToUse, items: [], totalItems: 0 });
  }

  const stationIds = stations.map(s => s.id);

  // 4. Get menu items with nutrients
  let { data: items, error: itemErr } = await supabase
    .from('menu_items')
    .select(`
      id, name, calories, portion, is_vegetarian, is_vegan, is_high_protein, station_id,
      stations!inner(id, name),
      nutrients(name, value, uom, value_numeric)
    `)
    .eq('date', dateToUse)
    .in('station_id', stationIds);

  // Fallback without join if the relation select fails
  if (itemErr || !items || items.length === 0) {
    const { data: simple } = await supabase
      .from('menu_items')
      .select('id, name, calories, portion, is_vegetarian, is_vegan, is_high_protein, station_id')
      .eq('date', dateToUse)
      .in('station_id', stationIds);
    items = simple || [];
  }

  const stationMap = Object.fromEntries(stations.map(s => [s.id, s.name]));

  const formatted = items.map(item => {
    const nuts = item.nutrients || [];
    const find = (keyword) => {
      const n = nuts.find(n => n.name?.toLowerCase().includes(keyword));
      return n ? `${n.value}${n.uom ? ' ' + n.uom : ''}`.trim() : null;
    };
    return {
      id: item.id,
      name: item.name,
      calories: item.calories ?? null,
      portion: item.portion ?? null,
      station: item.stations?.name ?? stationMap[item.station_id] ?? null,
      isVegetarian: item.is_vegetarian ?? false,
      isVegan: item.is_vegan ?? false,
      isHighProtein: item.is_high_protein ?? false,
      protein: find('protein'),
      fat: find('total fat'),
      carbs: find('total carbohydrate'),
      fiber: find('dietary fiber'),
      sodium: find('sodium'),
      sugar: find('total sugar'),
      description: null,
    };
  });

  return res.json({
    location: location.name,
    period: period.name,
    date: dateToUse,
    items: formatted,
    totalItems: formatted.length,
  });
}
