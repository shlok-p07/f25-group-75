import { useState, useEffect } from "react";
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

  return (
    <div className="relative min-h-screen bg-black text-white">
      <FoodBackground />
      <div className="relative z-10 max-w-5xl mx-auto px-4 pt-24 pb-16">

        <div className="mb-8">
          <h1 className="text-3xl font-bold text-white">Dining Hours</h1>
          <p className="text-gray-400 mt-1 text-sm">
            Hours auto-update daily from DineOnCampus — reflects current semester schedule.
          </p>
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

        {!isLoading && !error && locations.map(loc => (
          <div key={loc.id} className="mb-6 bg-white/5 border border-white/10 rounded-2xl overflow-hidden">
            <div className="px-5 py-4 border-b border-white/8 flex items-center justify-between">
              <h2 className="text-white font-semibold text-base">{loc.name}</h2>
              {(() => {
                const today = loc.week.find(d => d.date === todayStr);
                if (!today) return null;
                const isOpen = today.status === 'open' || today.always_open;
                return (
                  <span className={`text-xs font-semibold px-2.5 py-1 rounded-full ${
                    isOpen ? 'bg-green-500/15 text-green-400 border border-green-500/20'
                           : 'bg-red-500/15 text-red-400 border border-red-500/20'
                  }`}>
                    {isOpen ? 'Open Today' : 'Closed Today'}
                  </span>
                );
              })()}
            </div>

            <div className="divide-y divide-white/5">
              {loc.week.map(day => {
                const isToday = day.date === todayStr;
                const isOpen  = day.status === 'open' || day.always_open;
                return (
                  <div
                    key={day.date}
                    className={`flex items-center justify-between px-5 py-3 text-sm ${
                      isToday ? 'bg-white/5' : ''
                    }`}
                  >
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
                      isOpen ? (isToday ? 'text-green-400' : 'text-gray-300')
                              : 'text-gray-500'
                    }`}>
                      {isOpen ? (day.display || 'Open') : 'Closed'}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
