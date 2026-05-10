import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

function fmt(hour, minutes) {
  const h = hour % 12 || 12;
  const m = minutes === 0 ? '' : `:${String(minutes).padStart(2, '0')}`;
  const ampm = hour < 12 ? 'AM' : 'PM';
  return `${h}${m} ${ampm}`;
}

function formatSlots(slots) {
  if (!slots?.length) return null;
  return slots.map(s => `${fmt(s.start_hour, s.start_minutes)} – ${fmt(s.end_hour, s.end_minutes)}`).join(', ');
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const end = new Date();
  end.setDate(end.getDate() + 6);
  const endDate = end.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

  const { data, error } = await supabase
    .from('location_hours')
    .select('location_original_id, location_name, location_slug, date, day_of_week, status, hours, has_special_hours, always_open')
    .gte('date', today)
    .lte('date', endDate)
    .order('date', { ascending: true });

  if (error) return res.status(500).json({ error: error.message });
  if (!data?.length) return res.status(404).json({ error: 'No hours data available yet.' });

  const map = {};
  for (const row of data) {
    if (!map[row.location_original_id]) {
      map[row.location_original_id] = {
        id:   row.location_original_id,
        name: row.location_name,
        slug: row.location_slug,
        week: [],
      };
    }
    map[row.location_original_id].week.push({
      date:              row.date,
      day_of_week:       row.day_of_week,
      status:            row.status,
      hours:             row.hours,
      display:           row.always_open ? 'Open 24 hours' : formatSlots(row.hours),
      has_special_hours: row.has_special_hours,
      always_open:       row.always_open,
    });
  }

  const locations = Object.values(map).sort((a, b) => a.name.localeCompare(b.name));
  return res.json({ locations, week_start: today, week_end: endDate });
}
