import React from 'react';
import { Link } from 'react-router-dom';
import FoodBackground from '../Components/background';

const dietaryInfo = [
  {
    icon: '🌱',
    label: 'Vegan',
    def: 'No animal products of any kind — no meat, dairy, or eggs.',
  },
  {
    icon: '🥦',
    label: 'Vegetarian',
    def: 'No meat, poultry, fish, or seafood. May contain eggs or dairy.',
  },
  {
    icon: '💪',
    label: 'High Protein',
    def: 'Flagged "Good Source of Protein" by the dining team — typically 15 g+ per serving.',
  },
];

const features = [
  {
    icon: '🍽️',
    title: 'Live Menus',
    desc: 'Daily Breakfast, Lunch, and Dinner items — auto-scraped each morning.',
  },
  {
    icon: '🕐',
    title: 'Real Hours',
    desc: 'Open/closed status and weekly schedules for every campus dining location.',
    link: '/hours',
    linkLabel: 'See Hours →',
  },
  {
    icon: '📊',
    title: 'Nutrition Tracker',
    desc: 'Log what you ate and track calories, protein, and other macros over time.',
    link: '/tracker',
    linkLabel: 'Open Tracker →',
  },
  {
    icon: '🗳️',
    title: 'Vote',
    desc: 'Compare dining halls and rate today\'s menus with the rest of campus.',
    link: '/vote',
    linkLabel: 'Cast a vote →',
  },
];

export default function About() {
  return (
    <div className="min-h-screen bg-black relative overflow-hidden">
      <FoodBackground />

      <div className="relative z-10 max-w-5xl mx-auto px-4 sm:px-6 pt-28 pb-20">

        {/* Header */}
        <div className="text-center mb-14">
          <h1 className="text-4xl md:text-5xl font-extrabold text-white mb-3">
            About NU Dining
          </h1>
          <p className="text-white/45 text-lg max-w-2xl mx-auto">
            A live, student-built companion app for Northeastern dining — menus, hours,
            nutrition tracking, and hall ratings, all auto-updated daily from DineOnCampus.
          </p>
        </div>

        {/* Feature cards */}
        <div className="grid sm:grid-cols-2 gap-4 mb-14">
          {features.map(f => (
            <div
              key={f.title}
              className="bg-white/4 backdrop-blur-sm border border-white/8 rounded-2xl p-6 flex flex-col gap-3"
            >
              <div className="flex items-center gap-3">
                <span className="text-2xl">{f.icon}</span>
                <h2 className="text-lg font-bold text-white">{f.title}</h2>
              </div>
              <p className="text-sm text-white/50 leading-relaxed flex-1">{f.desc}</p>
              {f.link && (
                <Link
                  to={f.link}
                  className="text-sm font-medium text-red-400 hover:text-red-300 transition-colors mt-1"
                >
                  {f.linkLabel}
                </Link>
              )}
            </div>
          ))}
        </div>

        {/* Dietary labels */}
        <div className="bg-white/4 backdrop-blur-sm border border-white/8 rounded-2xl p-8">
          <h2 className="text-2xl font-bold text-white mb-1 text-center">Dietary Labels</h2>
          <p className="text-white/35 text-sm text-center mb-8">
            All labels come directly from the DineOnCampus API — not estimated.
          </p>

          <div className="grid md:grid-cols-3 gap-6">
            {dietaryInfo.map(item => (
              <div key={item.label} className="flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  <span className="text-2xl">{item.icon}</span>
                  <span className="text-white font-semibold">{item.label}</span>
                </div>
                <p className="text-sm text-white/45 leading-relaxed">{item.def}</p>
              </div>
            ))}
          </div>

          <p className="mt-8 pt-5 border-t border-white/6 text-[11px] text-white/20 text-center">
            All data sourced live from DineOnCampus · Subject to change during finals, breaks &amp; holidays
          </p>
        </div>

      </div>
    </div>
  );
}
