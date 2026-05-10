import { useState, useEffect, useMemo } from "react";
import FoodBackground from "../Components/background";

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function formatDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export default function Hours() {
  const [locations, setLocations] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError]         = useState(null);
  const [search, setSearch]       = useState('');

  useEffect(() => {
    fetch('/api/hours')
      .then(r => r.json())
      .then(data => {
        if (data.error) { setError(data.error); return; }
        setLocations(data.locations || []);
      })
      .catch(() => setError('Failed to load hours.'))
      .finally(() => setIsLoading(false));
  }, []);

  const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

  const sortedLocations = useMemo(() => {
    const isOpenToday = loc => {
      const t = loc.week?.find(d => d.date === todayStr);
      return t && (t.status === 'open' || t.always_open);
    };
    const q = search.trim().toLowerCase();
    return [...locations]
      .filter(l => !q || l.name.toLowerCase().includes(q))
      .sort((a, b) => {
        const aOpen = isOpenToday(a) ? 1 : 0;
        const bOpen = isOpenToday(b) ? 1 : 0;
        if (aOpen !== bOpen) return bOpen - aOpen; // open first
        return a.name.localeCompare(b.name);
      });
  }, [locations, search, todayStr]);

  const openCount   = sortedLocations.filter(l => {
    const t = l.week?.find(d => d.date === todayStr);
    return t && (t.status === 'open' || t.always_open);
  }).length;
  const closedCount = sortedLocations.length - openCount;

  return (
    <div className="relative min-h-screen bg-black text-white">
      <FoodBackground />
      <div className="relative z-10 max-w-5xl mx-auto px-4 pt-24 pb-16">

        <div className="mb-6">
          <h1 className="text-3xl font-bold text-white">Dining Hours</h1>
          <p className="text-gray-400 mt-1 text-sm">
            Hours auto-update daily from DineOnCampus — reflects current semester schedule.
          </p>
        </div>

        {/* Search + summary */}
        <div className="mb-6 flex flex-col sm:flex-row sm:items-center gap-3">
          <div className="relative flex-1 max-w-md">
            <svg className="w-4 h-4 text-gray-500 absolute left-3 top-1/2 -translate-y-1/2"
                 fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M21 21l-4.35-4.35M11 19a8 8 0 110-16 8 8 0 010 16z" />
            </svg>
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search locations..."
              className="w-full bg-white/5 border border-white/10 rounded-full pl-9 pr-4 py-2 text-sm text-white
                         placeholder:text-gray-500 focus:outline-none focus:border-red-500/40 focus:bg-white/8"
            />
          </div>
          {!isLoading && !error && (
            <div className="flex items-center gap-3 text-xs text-gray-400 shrink-0">
              <span className="flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-green-400" />
                {openCount} open
              </span>
              <span className="flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-gray-500" />
                {closedCount} closed
              </span>
            </div>
          )}
        </div>

        {isLoading && (
          <div className="flex items-center justify-center py-24">
            <div className="w-8 h-8 border-2 border-red-500 border-t-transparent rounded-full animate-spin" />
          </div>
        )}

        {error && !isLoading && (
          <div className="bg-white/5 border border-white/10 rounded-2xl p-8 text-center">
            <p className="text-white text-lg font-semibold">No hours available yet</p>
            <p className="text-gray-400 mt-2 text-sm">{error}</p>
          </div>
        )}

        {!isLoading && !error && sortedLocations.length === 0 && (
          <div className="bg-white/5 border border-white/10 rounded-2xl p-8 text-center">
            <p className="text-gray-400 text-sm">No locations match "{search}".</p>
          </div>
        )}

        {!isLoading && !error && sortedLocations.map(loc => {
          const today  = loc.week.find(d => d.date === todayStr);
          const isOpen = today && (today.status === 'open' || today.always_open);
          return (
            <div key={loc.id}
                 className={`mb-6 bg-white/5 border rounded-2xl overflow-hidden ${
                   isOpen ? 'border-white/10' : 'border-white/8 opacity-70'
                 }`}>
              <div className="px-5 py-4 border-b border-white/8 flex items-center justify-between">
                <h2 className="text-white font-semibold text-base">{loc.name}</h2>
                {today && (
                  <span className={`text-xs font-semibold px-2.5 py-1 rounded-full ${
                    isOpen ? 'bg-green-500/15 text-green-400 border border-green-500/20'
                           : 'bg-red-500/15 text-red-400 border border-red-500/20'
                  }`}>
                    {isOpen ? 'Open Today' : 'Closed Today'}
                  </span>
                )}
              </div>

              <div className="divide-y divide-white/5">
                {loc.week.map(day => {
                  const isToday  = day.date === todayStr;
                  const dayOpen  = day.status === 'open' || day.always_open;
                  return (
                    <div key={day.date}
                         className={`flex items-center justify-between px-5 py-3 text-sm ${
                           isToday ? 'bg-white/5' : ''
                         }`}>
                      <div className="flex items-center gap-3">
                        {isToday
                          ? <span className="w-1.5 h-1.5 rounded-full bg-red-400 shrink-0" />
                          : <span className="w-1.5 h-1.5 shrink-0" />}
                        <span className={`w-8 font-medium ${isToday ? 'text-white' : 'text-gray-400'}`}>
                          {DAY_NAMES[day.day_of_week]}
                        </span>
                        <span className={`text-xs ${isToday ? 'text-gray-300' : 'text-gray-500'}`}>
                          {formatDate(day.date)}
                        </span>
                        {day.has_special_hours && (
                          <span className="text-xs text-yellow-400 border border-yellow-400/20 bg-yellow-400/10 px-1.5 py-0.5 rounded-full">
                            Special Hours
                          </span>
                        )}
                      </div>
                      <span className={`font-medium ${
                        dayOpen ? (isToday ? 'text-green-400' : 'text-gray-300')
                                : 'text-gray-500'
                      }`}>
                        {dayOpen ? (day.display || 'Open') : 'Closed'}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
