# NU-Dining App

A campus dining companion for Northeastern University students. Browse real-time menus across all three residential dining halls, filter by dietary preference, vote on your favorite hall each meal period, and track your daily nutrition intake.

---

## Features

- **Menu Browsing** — View today's menu for Stetson East, International Village, and 60 Belvidere across breakfast, lunch, and dinner. Filter by vegan, vegetarian, non-veg, or high-protein.
- **Nutritional Details** — Every item shows calories, protein, carbs, fat, fiber, sodium, and sugar sourced directly from DineOnCampus.
- **Community Voting** — Vote which dining hall is better for each meal period. One vote per user per period per day, with real-time leaderboard updates via Supabase Realtime.
- **Nutrition Tracker** — Log your meals, set personalized macro goals, and visualize daily intake with progress rings and historical charts.
- **Authentication** — Email/password signup and login with full password reset flow via Supabase Auth.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 18, Vite, Tailwind CSS v4, React Router v7 |
| Backend | Node.js, Express v5 |
| Database | Supabase (PostgreSQL + Auth + Realtime) |
| Scraping | Puppeteer v24 (headless Chrome, Cloudflare bypass) |
| Charts | Recharts |
| Animations | GSAP, Framer Motion |
| Deployment | Vercel (frontend + cron), GitHub Actions (daily scrape) |

---

## Project Structure

```
f25-group-75/
├── front-end/              # React app (Vite)
│   ├── src/
│   │   ├── pages/          # Home, DiningHall, Vote, Tracker, Auth pages
│   │   ├── Components/     # MenuCard, Navbar, animations, background
│   │   ├── functions/      # Vote helpers
│   │   └── config/         # Supabase client
│   └── api/                # Vercel serverless functions (menu API, scrape cron)
├── backend-folder/         # Express API server + Puppeteer scraper
│   ├── index.js            # REST API
│   └── run-scrape.js       # Manual scrape script
└── supabase/
    └── migrations/         # SQL schema (tables, RLS policies)
```

---

## Getting Started

### Prerequisites

- Node.js 22+
- A [Supabase](https://supabase.com) project with migrations applied

### 1. Clone and install

```bash
git clone <repo-url>
cd f25-group-75

# Install all dependencies
npm install
cd backend-folder && npm install && cd ..
cd front-end && npm install && cd ..
```

### 2. Configure environment variables

**`backend-folder/.env`**
```env
SUPABASE_URL=your_supabase_project_url
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key
PORT=3000
```

**`front-end/.env`**
```env
VITE_SUPABASE_URL=your_supabase_project_url
VITE_SUPABASE_ANON_KEY=your_anon_key
```

### 3. Apply database migrations

Run the following in order via the Supabase Dashboard SQL editor or Supabase CLI:

```
supabase/migrations/001_create_tables.sql
supabase/migrations/002_nutrition_tracker.sql
supabase/migrations/003_votes.sql
```

### 4. Run locally

```bash
# Start both frontend (port 5173) and backend (port 3000) concurrently
npm run dev
```

The frontend dev server proxies `/api` requests to the backend automatically.

### 5. Populate today's menu

```bash
cd backend-folder
node run-scrape.js
```

This launches a headless browser, loads DineOnCampus to establish a Cloudflare session, then fetches full menu data (including nutrients and dietary filters) for all three dining halls and inserts it into Supabase.

---

## Deployment

### Frontend — Vercel

Push to `main` to trigger an automatic Vercel deploy. Set the following environment variables in the Vercel dashboard:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `CRON_SECRET` (any secret string — used to authenticate the cron endpoint)

### Automated Scraping

Menu data is scraped daily via two mechanisms:

- **GitHub Actions** (`.github/workflows/daily-scrape.yml`) — runs at 5 AM and 7 AM UTC
- **Vercel Cron** (`vercel.json`) — triggers `/api/scrape` on a daily schedule

Add `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and `CRON_SECRET` as GitHub repository secrets for the Actions workflow.

---

## Database Schema

| Table | Description |
|---|---|
| `locations` | Dining halls with a date stamp per scrape |
| `periods` | Meal periods (Breakfast, Lunch, Dinner) per location |
| `stations` | Food stations within each period |
| `menu_items` | Individual items with calories, dietary flags, and portion info |
| `nutrients` | Per-item macros and micros (protein, carbs, fat, fiber, sodium, sugar) |
| `food_logs` | User meal log entries for the nutrition tracker |
| `nutrition_goals` | Per-user daily macro targets |
| `votes` | User votes with a unique constraint on `(user_id, vote_date, meal_period)` |

Row-level security is enforced on all tables — dining data is publicly readable, personal data (logs, goals, votes) requires authentication.

---

## Contributing

1. Fork the repo and create a feature branch
2. Run `npm run dev` to start local development
3. Open a pull request against `main`
