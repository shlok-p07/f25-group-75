import { useState, useEffect, useMemo, useRef } from "react";
import FoodBackground from "../Components/background";
import MenuCard from "../Components/MenuCard";
import { useParams, Link } from "react-router-dom";

// ── Station Hopper helpers ───────────────────────────────────────────────────
const STATION_EMOJI = {
    'CUCINA': '🍕',
    'RICE STATION': '🍚',
    'HOMESTYLE': '🏡',
    'MENUTAINMENT': '🍳',
    'SOUP': '🍲',
    'FLAME': '🔥',
    'DELI': '🥪',
    'SWEET SHOPPE': '🍰',
    'DELICIOUS WITHOUT': '🌾',
    'FRESH 52 A': '🥗',
    'FRESH 52 B': '🥗',
};

function getStationEmoji(name) {
    const upper = (name || '').toUpperCase();
    if (STATION_EMOJI[upper]) return STATION_EMOJI[upper];
    if (upper.includes('FRESH'))                          return '🥗';
    if (upper.includes('PIZZA'))                          return '🍕';
    if (upper.includes('GRILL') || upper.includes('FLAME')) return '🔥';
    if (upper.includes('SALAD'))                          return '🥗';
    if (upper.includes('RICE'))                           return '🍚';
    if (upper.includes('SOUP'))                           return '🍲';
    if (upper.includes('DELI') || upper.includes('SANDWICH')) return '🥪';
    if (upper.includes('BREAKFAST') || upper.includes('EGG')) return '🍳';
    if (upper.includes('SWEET') || upper.includes('DESSERT'))  return '🍰';
    if (upper.includes('PASTA') || upper.includes('NOODLE'))   return '🍝';
    if (upper.includes('DRINK') || upper.includes('BEVERAGE')) return '☕';
    if (upper.includes('FRUIT'))                          return '🍎';
    return '🍽️';
}

function slugify(s) {
    return (s || '').toLowerCase().replace(/[^\w]+/g, '-').replace(/^-+|-+$/g, '') || 'other';
}

function getTodayET() {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

function get7Dates() {
    const dates = [];
    for (let i = 0; i <= 6; i++) {
        const d = new Date();
        d.setDate(d.getDate() + i);
        dates.push(d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' }));
    }
    return dates;
}

function formatPillDate(dateStr) {
    const today = getTodayET();
    if (dateStr === today) return 'Today';
    const [y, m, d] = dateStr.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    return dt.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

export function DiningHall() {
    const [menuItems, setMenuItems] = useState([]);
    const [isLoading, setIsLoading] = useState(false);
    const [displayDate, setDisplayDate] = useState(null);
    const [activeFilters, setActiveFilters] = useState(new Set());
    const [notServed, setNotServed] = useState(false);
    const [isClosed, setIsClosed] = useState(false);
    const [mealNotPosted, setMealNotPosted] = useState(false);
    const [selectedDate, setSelectedDate] = useState(getTodayET());
    const [searchQuery, setSearchQuery] = useState("");
    const dateOptions = useMemo(() => get7Dates(), []);
    const { hall = "stetson-east", meal = "breakfast" } = useParams();

    const dietaryRestrictions = [
        { label: "Vegan", value: "vegan" },
        { label: "Vegetarian", value: "vegetarian" },
        { label: "Non-Veg", value: "non-veg" },
        { label: "High Protein", value: "high-protein" },
    ];

    const toggleFilter = (value) => {
        setActiveFilters(prev => {
            const next = new Set(prev);
            if (next.has(value)) next.delete(value);
            else next.add(value);
            return next;
        });
    };

    const fetchMenu = async () => {
        setIsLoading(true);
        setNotServed(false);
        setIsClosed(false);
        setMealNotPosted(false);
        try {
            const res = await fetch(`/api/menu/${hall}/${meal}?date=${selectedDate}`);
            if (res.status === 404) {
                const json = await res.json().catch(() => ({}));
                if (json.error === 'meal_not_posted') {
                    setMealNotPosted(true);
                } else {
                    setNotServed(true);
                }
                setMenuItems([]);
                setDisplayDate(null);
                return;
            }
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const json = await res.json();
            // With explicit date param the API only returns data for that date,
            // so a mismatch here means the hall is closed on the selected date.
            if (json.date && json.date !== selectedDate) {
                setIsClosed(true);
                setMenuItems([]);
                setDisplayDate(null);
                return;
            }
            const normalized = (json.items || []).map(i => {
                // Parse protein grams from the nutrient string the API returns (e.g. "15 g" → 15)
                let proteinGrams = null;
                if (i.protein) {
                    const match = String(i.protein).match(/(\d+(?:\.\d+)?)/);
                    if (match) proteinGrams = parseFloat(match[1]);
                }

                // High protein: use DineOnCampus's own "Good Source of Protein" flag,
                // or fall back to ≥15 g per serving (FDA threshold for a "good source")
                const isHigh = Boolean(i.isHighProtein || i.is_high_protein)
                    || (proteinGrams !== null && proteinGrams >= 15);

                return {
                    id: i.id,
                    name: i.name || i.title || '',
                    calories: i.calories ?? null,
                    portion: i.portion ?? null,
                    station: i.station ?? null,
                    protein: i.protein ?? null,
                    fat: i.fat ?? null,
                    carbs: i.carbs ?? null,
                    fiber: i.fiber ?? null,
                    sodium: i.sodium ?? null,
                    sugar: i.sugar ?? null,
                    is_high_protein: isHigh,
                    is_vegetarian: Boolean(i.isVegetarian || i.is_vegetarian),
                    is_vegan: Boolean(i.isVegan || i.is_vegan),
                    description: i.description ?? null,
                };
            });
            setMenuItems(normalized);
            setDisplayDate(json.date || null);
        } catch (err) {
            console.error('fetchMenu error', err);
            setMenuItems([]);
        } finally {
            setIsLoading(false);
        }
    };

    useEffect(() => { fetchMenu(); }, [hall, meal, selectedDate]);

    return (
        <div className="min-h-screen bg-linear-to-br from-black via-gray-900 to-black relative">
            <FoodBackground />
            <div className="relative z-10 flex flex-col min-h-screen">
                <main className="flex-1 flex flex-col items-center justify-start pt-28 px-6 pb-20 w-full">
                    <div className="w-full max-w-6xl">
                        <div className="flex flex-col gap-3 mb-6">
                            <div>
                                <h1 className="text-2xl sm:text-3xl md:text-5xl font-extrabold text-white leading-tight">
                                    {(hall || "").split("-").map((s) => s[0]?.toUpperCase() + s.slice(1)).join(" ")}
                                    <span className="text-red-400"> {meal && meal[0]?.toUpperCase() + meal.slice(1)}</span>
                                </h1>
                                {displayDate && (
                                    <p className="text-xs text-gray-400 mt-1">Showing menu for <span className="font-medium text-white">{displayDate}</span>.</p>
                                )}
                            </div>

                            {/* Date picker — today + 6 future days */}
                            <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1 [scrollbar-width:none] [&amp;::-webkit-scrollbar]:hidden">
                                {dateOptions.map(d => {
                                    const isSelected = d === selectedDate;
                                    return (
                                        <button
                                            key={d}
                                            onClick={() => setSelectedDate(d)}
                                            className={`shrink-0 px-3 py-1.5 rounded-full text-xs font-medium transition border ${
                                                isSelected
                                                    ? 'bg-red-500 text-white border-red-500'
                                                    : 'bg-white/5 text-white/70 border-white/10 hover:bg-white/10 hover:text-white'
                                            }`}
                                        >
                                            {formatPillDate(d)}
                                        </button>
                                    );
                                })}
                            </div>

                            {/* Search bar — matches item names and station names */}
                            <div className="relative w-full max-w-md">
                                <svg className="w-4 h-4 text-gray-500 absolute left-3 top-1/2 -translate-y-1/2"
                                     fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                                          d="M21 21l-4.35-4.35M11 19a8 8 0 110-16 8 8 0 010 16z" />
                                </svg>
                                <input
                                    type="text"
                                    value={searchQuery}
                                    onChange={e => setSearchQuery(e.target.value)}
                                    placeholder="Search items or stations..."
                                    className="w-full bg-white/5 border border-white/10 rounded-full pl-9 pr-9 py-2 text-sm text-white
                                               placeholder:text-gray-500 focus:outline-none focus:border-red-500/40 focus:bg-white/8"
                                />
                                {searchQuery && (
                                    <button
                                        onClick={() => setSearchQuery("")}
                                        className="absolute right-2 top-1/2 -translate-y-1/2 w-6 h-6 rounded-full
                                                   text-gray-400 hover:text-white hover:bg-white/10 flex items-center justify-center transition"
                                        aria-label="Clear search"
                                    >
                                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                                        </svg>
                                    </button>
                                )}
                            </div>

                            <div className="flex flex-wrap items-center gap-2">
                                <div className="bg-white/6 text-white px-3 py-1.5 rounded-full text-sm font-medium shrink-0">{menuItems.length} Items</div>
                                {dietaryRestrictions.map(d => (
                                    <button
                                        key={d.value}
                                        onClick={() => toggleFilter(d.value)}
                                        className={`px-3 py-1.5 rounded-full text-sm font-medium transition ${activeFilters.has(d.value) ? 'bg-red-500 text-white' : 'bg-white/6 text-white'}`}
                                    >
                                        {d.label}
                                    </button>
                                ))}
                                <button
                                    onClick={fetchMenu}
                                    disabled={isLoading}
                                    className={`px-4 py-1.5 rounded-full text-sm font-semibold transition transform shrink-0 ${isLoading ? 'bg-red-600 opacity-75 scale-95' : 'bg-red-500 hover:bg-red-600 active:scale-95'}`}
                                >
                                    {isLoading ? 'Loading...' : 'Refresh'}
                                </button>
                            </div>
                        </div>

                        {/** Filter items in-memory for a clean UI */}
                        <ItemGrid menuItems={menuItems} activeFilters={activeFilters} searchQuery={searchQuery} isLoading={isLoading} notServed={notServed} isClosed={isClosed} mealNotPosted={mealNotPosted} meal={meal} hall={hall} selectedDate={selectedDate} />
                    </div>
                </main>
            </div>
        </div>
    );
}

export default DiningHall;

function ItemGrid({ menuItems, activeFilters, searchQuery, isLoading, notServed, isClosed, mealNotPosted, meal, hall, selectedDate }) {
    const filteredMenuItems = useMemo(() => {
        const q = (searchQuery || '').trim().toLowerCase();
        return menuItems.filter(item => {
            const name = (item.name || '').toLowerCase();
            const station = (item.station || '').toLowerCase();

            // Search: match on item name OR station name (so searching "FLAME" shows the whole grill section)
            if (q && !name.includes(q) && !station.includes(q)) return false;

            // Dietary filters (AND logic across active filters)
            if (activeFilters.size === 0) return true;
            for (const filter of activeFilters) {
                if (filter === 'high-protein') {
                    if (!item.is_high_protein) return false;
                } else if (filter === 'vegan') {
                    const veganKeywords = ['vegan','plant-based','tofu','seitan','tempeh'];
                    if (!item.is_vegan && !veganKeywords.some(k => name.includes(k))) return false;
                } else if (filter === 'vegetarian') {
                    const vegKeywords = ['cheese','egg','vegetarian','paneer','tofu','mushroom'];
                    if (!item.is_vegetarian && !item.is_vegan && !vegKeywords.some(k => name.includes(k))) return false;
                } else if (filter === 'non-veg') {
                    const nonVegKeywords = ['chicken','turkey','beef','pork','salmon','tuna','shrimp','steak','ham','bacon','sausage','lamb','fish','crab','lobster','clam','oyster','anchovy','pepperoni'];
                    const isNonVeg = !item.is_vegan && !item.is_vegetarian && nonVegKeywords.some(k => name.includes(k));
                    if (!isNonVeg) return false;
                }
            }
            return true;
        });
    }, [menuItems, activeFilters, searchQuery]);

    const hallName = (hall || "").split("-").map(s => s[0]?.toUpperCase() + s.slice(1)).join(" ");
    const mealName = meal ? meal[0].toUpperCase() + meal.slice(1) : "";
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const isToday = selectedDate === today;
    const dateLabel = isToday ? 'today' : (() => {
        const [y, m, d] = (selectedDate || '').split('-').map(Number);
        if (!y) return 'that day';
        return new Date(y, m - 1, d).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
    })();

    const emptyState = (() => {
        if (isLoading) return null;
        if (isClosed || notServed) return (
            <div className="col-span-full bg-white/5 rounded-2xl p-10 text-center border border-white/8">
                <p className="text-4xl mb-4">🔒</p>
                <p className="text-white text-xl font-semibold">{hallName} is closed {dateLabel}</p>
                <p className="text-gray-400 mt-2 text-sm">This dining hall isn't serving {dateLabel}. Check the full weekly schedule to see when it reopens, or try a different hall.</p>
                <Link to="/hours" className="inline-block mt-4 text-sm font-medium text-red-400 hover:text-red-300 transition-colors">
                    See weekly hours →
                </Link>
            </div>
        );
        if (mealNotPosted) return (
            <div className="col-span-full bg-white/5 rounded-2xl p-10 text-center border border-white/8">
                <p className="text-4xl mb-4">⏳</p>
                <p className="text-white text-xl font-semibold">{mealName} menu not available {isToday ? 'yet' : `for ${dateLabel}`}</p>
                <p className="text-gray-400 mt-2 text-sm">
                    {isToday
                        ? `The ${mealName.toLowerCase()} menu hasn't been posted yet. Check back closer to mealtime.`
                        : `DineOnCampus hasn't posted the ${mealName.toLowerCase()} menu for ${dateLabel} yet. Try a different day.`}
                </p>
            </div>
        );
        if (menuItems.length > 0 && filteredMenuItems.length === 0) {
            const hasSearch  = (searchQuery || '').trim().length > 0;
            const hasFilters = activeFilters.size > 0;
            const heading = hasSearch && hasFilters
                ? 'No items match your search and filters'
                : hasSearch
                    ? `No items match "${searchQuery.trim()}"`
                    : 'No items match your filters';
            const sub = hasSearch && hasFilters
                ? 'Try clearing the search or removing a filter.'
                : hasSearch
                    ? 'Try a different keyword, or check another meal/day.'
                    : 'Try removing a filter or two to see more options.';
            return (
                <div className="col-span-full bg-white/5 rounded-2xl p-10 text-center border border-white/8">
                    <p className="text-4xl mb-4">🔍</p>
                    <p className="text-white text-xl font-semibold">{heading}</p>
                    <p className="text-gray-400 mt-2 text-sm">{sub}</p>
                </div>
            );
        }
        if (menuItems.length === 0) return (
            <div className="col-span-full bg-white/5 rounded-2xl p-10 text-center border border-white/8">
                <p className="text-4xl mb-4">🔒</p>
                <p className="text-white text-xl font-semibold">{hallName} is closed {dateLabel}</p>
                <p className="text-gray-400 mt-2 text-sm">This dining hall isn't serving {dateLabel}. Check the full weekly schedule to see when it reopens, or try a different hall.</p>
                <Link to="/hours" className="inline-block mt-4 text-sm font-medium text-red-400 hover:text-red-300 transition-colors">
                    See weekly hours →
                </Link>
            </div>
        );
        return null;
    })();

    return (
        <div>
            <div className="text-sm text-gray-300 mb-3">Showing <span className="text-white font-medium">{filteredMenuItems.length}</span> of <span className="text-white font-medium">{menuItems.length}</span> items</div>
            {emptyState ? (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6 items-start">{emptyState}</div>
            ) : (
                <StationGroupedItems items={filteredMenuItems} />
            )}
        </div>
    );
}

function StationGroupedItems({ items }) {
    const sectionRefs = useRef({});
    const chipRefs    = useRef({});
    const [activeSlug, setActiveSlug] = useState(null);

    // Group by station, preserve original ordering
    const groups = useMemo(() => {
        const map = new Map();
        for (const item of items) {
            const name = item.station || 'Other';
            if (!map.has(name)) map.set(name, []);
            map.get(name).push(item);
        }
        return Array.from(map, ([name, list]) => ({
            name,
            slug:  slugify(name),
            emoji: getStationEmoji(name),
            items: list,
        }));
    }, [items]);

    // Highlight chip whose section is in the upper half of the viewport
    useEffect(() => {
        if (groups.length <= 1) return;
        const observer = new IntersectionObserver((entries) => {
            const visible = entries
                .filter(e => e.isIntersecting)
                .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
            if (visible.length > 0) {
                const slug = visible[0].target.dataset.station;
                setActiveSlug(slug);
                // Center the active chip in its scroll container — horizontal only,
                // never touches the window/vertical scroll (avoids scroll-jacking).
                const chip = chipRefs.current[slug];
                const container = chip?.parentElement;
                if (chip && container) {
                    const targetLeft = chip.offsetLeft - (container.clientWidth - chip.offsetWidth) / 2;
                    container.scrollTo({ left: targetLeft, behavior: 'smooth' });
                }
            }
        }, {
            // Trigger when section's top crosses ~25% from viewport top
            rootMargin: '-25% 0px -65% 0px',
            threshold: 0,
        });
        Object.values(sectionRefs.current).forEach(el => el && observer.observe(el));
        return () => observer.disconnect();
    }, [groups]);

    const jumpTo = (slug) => {
        const el = sectionRefs.current[slug];
        if (!el) return;
        const headerOffset = 140; // navbar (64) + chip bar (~64) + spacing
        const top = el.getBoundingClientRect().top + window.scrollY - headerOffset;
        window.scrollTo({ top, behavior: 'smooth' });
    };

    return (
        <>
            {/* Station hopper — sticky chip bar */}
            {groups.length > 1 && (
                <div className="sticky top-16 z-30 -mx-2 px-2 py-2 bg-black/85 backdrop-blur-md mb-4 rounded-xl border border-white/5">
                    <div className="flex gap-2 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                        {groups.map(g => {
                            const active = activeSlug === g.slug;
                            return (
                                <button
                                    key={g.slug}
                                    ref={el => { chipRefs.current[g.slug] = el; }}
                                    onClick={() => jumpTo(g.slug)}
                                    className={`shrink-0 px-3 py-1.5 rounded-full text-xs font-medium transition border whitespace-nowrap ${
                                        active
                                            ? 'bg-red-500 text-white border-red-500 shadow-md shadow-red-500/30'
                                            : 'bg-white/5 text-white/70 border-white/10 hover:bg-white/10 hover:text-white'
                                    }`}
                                >
                                    <span className="mr-1">{g.emoji}</span>
                                    {g.name}
                                    <span className={`ml-1.5 ${active ? 'text-white/90' : 'text-white/40'}`}>· {g.items.length}</span>
                                </button>
                            );
                        })}
                    </div>
                </div>
            )}

            {/* Grouped sections (chip bar above is sticky; section headers are regular for smooth scroll) */}
            {groups.map(g => (
                <section
                    key={g.slug}
                    ref={el => { sectionRefs.current[g.slug] = el; }}
                    data-station={g.slug}
                    className="mb-10 scroll-mt-32"
                >
                    <header className="py-2.5 px-3 mb-3 flex items-center gap-3 rounded-lg bg-white/5 border border-white/8">
                        <span className="text-xl">{g.emoji}</span>
                        <h3 className="text-white font-bold text-sm sm:text-base uppercase tracking-wider">{g.name}</h3>
                        <span className="text-xs text-gray-500 ml-auto">{g.items.length} {g.items.length === 1 ? 'item' : 'items'}</span>
                    </header>
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6 items-start">
                        {g.items.map(food => (
                            <MenuCard
                                key={food.id}
                                food={{
                                    name: food.name,
                                    calories: food.calories,
                                    portion: food.portion,
                                    station: food.station,
                                    protein: food.protein,
                                    fat: food.fat,
                                    carbs: food.carbs,
                                    fiber: food.fiber,
                                    sodium: food.sodium,
                                    sugar: food.sugar,
                                    is_high_protein: food.is_high_protein,
                                    is_vegetarian: food.is_vegetarian,
                                    is_vegan: food.is_vegan,
                                    description: food.description,
                                }}
                            />
                        ))}
                    </div>
                </section>
            ))}
        </>
    );
}