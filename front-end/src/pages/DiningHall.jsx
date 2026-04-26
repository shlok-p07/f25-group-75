import { useState, useEffect, useMemo } from "react";
import FoodBackground from "../Components/background";
import MenuCard from "../Components/MenuCard";
import { useParams } from "react-router-dom";

export function DiningHall() {
    const [menuItems, setMenuItems] = useState([]);
    const [isLoading, setIsLoading] = useState(false);
    const [displayDate, setDisplayDate] = useState(null);
    const [activeFilters, setActiveFilters] = useState(new Set());
    const [notServed, setNotServed] = useState(false);
    const [isClosed, setIsClosed] = useState(false);
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
        try {
            const res = await fetch(`/api/menu/${hall}/${meal}`);
            if (res.status === 404) {
                setNotServed(true);
                setMenuItems([]);
                setDisplayDate(null);
                return;
            }
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const json = await res.json();
            const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
            if (json.date && json.date !== today) {
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

    useEffect(() => { fetchMenu(); }, [hall, meal]);

    return (
        <div className="min-h-screen bg-linear-to-br from-black via-gray-900 to-black relative overflow-hidden">
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
                        <ItemGrid menuItems={menuItems} activeFilters={activeFilters} isLoading={isLoading} notServed={notServed} isClosed={isClosed} meal={meal} hall={hall} />
                    </div>
                </main>
            </div>
        </div>
    );
}

export default DiningHall;

function ItemGrid({ menuItems, activeFilters, isLoading, notServed, isClosed, meal, hall }) {
    const filteredMenuItems = useMemo(() => {
        if (activeFilters.size === 0) return menuItems;
        return menuItems.filter(item => {
            const name = (item.name || '').toLowerCase();
            // Item must pass ALL active filters (AND logic)
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
    }, [menuItems, activeFilters]);

    const hallName = (hall || "").split("-").map(s => s[0]?.toUpperCase() + s.slice(1)).join(" ");
    const mealName = meal ? meal[0].toUpperCase() + meal.slice(1) : "";

    const emptyState = (() => {
        if (isLoading) return null;
        if (isClosed || notServed) return (
            <div className="col-span-full bg-white/5 rounded-2xl p-10 text-center border border-white/8">
                <p className="text-4xl mb-4">🔒</p>
                <p className="text-white text-xl font-semibold">{hallName} is closed today</p>
                <p className="text-gray-400 mt-2 text-sm">This dining hall isn't serving today. Try a different hall or come back tomorrow.</p>
            </div>
        );
        if (menuItems.length > 0 && filteredMenuItems.length === 0) return (
            <div className="col-span-full bg-white/5 rounded-2xl p-10 text-center border border-white/8">
                <p className="text-4xl mb-4">🔍</p>
                <p className="text-white text-xl font-semibold">No items match your filters</p>
                <p className="text-gray-400 mt-2 text-sm">Try removing a filter or two to see more options.</p>
            </div>
        );
        if (menuItems.length === 0) return (
            <div className="col-span-full bg-white/5 rounded-2xl p-10 text-center border border-white/8">
                <p className="text-4xl mb-4">🔒</p>
                <p className="text-white text-xl font-semibold">{hallName} is closed today</p>
                <p className="text-gray-400 mt-2 text-sm">This dining hall isn't serving today. Try a different hall or come back tomorrow.</p>
            </div>
        );
        return null;
    })();

    return (
        <div>
            <div className="text-sm text-gray-300 mb-3">Showing <span className="text-white font-medium">{filteredMenuItems.length}</span> of <span className="text-white font-medium">{menuItems.length}</span> items</div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6 items-start">
                {emptyState ? emptyState : (
                    filteredMenuItems.map((food) => (
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
                    ))
                )}
            </div>
        </div>
    );
}