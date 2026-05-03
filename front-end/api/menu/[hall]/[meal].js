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

  const { hall, meal } = req.query;
  const locationKeyword = mapHall(hall);
  const periodName = mapMeal(meal);
  const locationPattern = `%${locationKeyword}%`;

  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  let dateToUse = today;

  // 1. Find location rows for today
  let { data: locations, error: locErr } = await supabase
    .from('locations')
    .select('id, name, date')
    .ilike('name', locationPattern)
    .eq('date', today);

  if (locErr) return res.status(500).json({ error: locErr.message });

  // Fallback 1: no location rows at all for today
  if (!locations || locations.length === 0) {
    const { data: latest } = await supabase
      .from('locations')
      .select('id, name, date')
      .ilike('name', locationPattern)
      .lt('date', today)
      .order('date', { ascending: false })
      .limit(10);
    if (latest && latest.length > 0) {
      locations = latest;
      dateToUse = latest[0].date;
    }
  }

  // Fallback 2: today has location rows but the scrape left no periods
  // (partial failure — inserts locations then errors out before periods/items)
  if (locations && locations.length > 0 && dateToUse === today) {
    const { data: hasPeriods } = await supabase
      .from('periods')
      .select('id')
      .in('location_id', locations.map(l => l.id))
      .limit(1);
    if (!hasPeriods || hasPeriods.length === 0) {
      const { data: prevLocs } = await supabase
        .from('locations')
        .select('id, name, date')
        .ilike('name', locationPattern)
        .lt('date', today)
        .order('date', { ascending: false })
        .limit(10);
      if (prevLocs && prevLocs.length > 0) {
        locations = prevLocs;
        dateToUse = prevLocs[0].date;
      }
    }
  }

  if (!locations || locations.length === 0) {
    return res.status(404).json({
      error: 'hall_closed',
      message: `No data found for ${locationKeyword}.`,
    });
  }

  // 2. Find a location+period that has stations for dateToUse
  let location = null;
  let period = null;

  for (const loc of locations) {
    const { data: periods } = await supabase
      .from('periods')
      .select('id, name, date')
      .eq('location_id', loc.id)
      .eq('name', periodName)
      .eq('date', dateToUse);

    if (!periods || periods.length === 0) continue;

    for (const p of periods) {
      const { data: stationCheck } = await supabase
        .from('stations')
        .select('id')
        .eq('period_id', p.id)
        .eq('date', dateToUse)
        .limit(1);

      if (stationCheck && stationCheck.length > 0) {
        location = loc;
        period = p;
        break;
      }
    }
    if (period) break;
  }

  if (!period) {
    return res.status(404).json({
      error: 'meal_not_posted',
      message: `No ${periodName} menu found for ${locationKeyword} on ${dateToUse}.`,
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
