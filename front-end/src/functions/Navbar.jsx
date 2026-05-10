import React, { useState, useEffect, useRef } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import "./Navbar.css";
import { supabase } from "../config/supabaseClient";

const NavLink = ({ to, children, onClick }) => {
  const location = useLocation();
  const active = location.pathname === to;
  return (
    <Link
      to={to}
      onClick={onClick}
      className={`px-4 py-2 rounded-full text-sm font-medium transition-all duration-200
        ${active
          ? "bg-red-500/20 text-red-400 border border-red-500/30"
          : "text-white/70 hover:text-white hover:bg-white/8"
        }`}
    >
      {children}
    </Link>
  );
};

export default function Navbar() {
  const [open, setOpen] = useState(false);
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const userMenuRef = useRef(null);
  const navigate = useNavigate();
  const location = useLocation();

  const hideOn = ["/login", "/signup", "/forgot", "/reset-password"];
  const shouldHide = hideOn.includes(location.pathname);

  useEffect(() => {
    let mounted = true;
    async function loadUser() {
      try {
        const { data } = await supabase.auth.getUser();
        if (mounted) setUser(data?.user ?? null);
      } catch {
        if (mounted) setUser(null);
      } finally {
        if (mounted) setLoading(false);
      }
    }
    loadUser();

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (mounted) setUser(session?.user ?? null);
    });

    function handleClickOutside(e) {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target)) {
        setUserMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);

    return () => {
      mounted = false;
      subscription?.unsubscribe();
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, []);

  async function handleSignOut() {
    await supabase.auth.signOut().catch(console.error);
    setUser(null);
    navigate("/login");
  }

  if (shouldHide) return null;

  const userInitial = (user?.email ?? user?.user_metadata?.full_name ?? "U").charAt(0).toUpperCase();
  const userLabel = user?.email ?? user?.user_metadata?.full_name ?? "User";

  return (
    <header className="navbar fixed top-0 left-0 right-0 z-[100] backdrop-blur-md bg-black/60 border-b border-white/5">
      <div className="max-w-7xl mx-auto px-4 md:px-6 flex items-center justify-between h-16">

        {/* ── Logo ── always links to /home, hover: scale + red glow */}
        <Link
          to="/home"
          className="flex items-center gap-3 group shrink-0"
          aria-label="Go to home"
        >
          <img
            src="/logo__7_-removebg-preview.png"
            alt="NU Rate-ON logo"
            className="w-10 h-10 rounded-md shadow-md
              transition-all duration-300
              group-hover:scale-110
              group-hover:drop-shadow-[0_0_10px_rgba(239,68,68,0.75)]"
          />
          <span className="text-xl font-bold text-white transition-colors duration-300 group-hover:text-red-400">
            NU Dining
          </span>
        </Link>

        {/* ── Desktop nav links — visible on ALL pages ── */}
        <nav className="hidden md:flex items-center gap-1">
          <NavLink to="/home">Home</NavLink>
          <NavLink to="/about">About</NavLink>
          <NavLink to="/hours">Hours</NavLink>
          {user && <NavLink to="/vote">Vote</NavLink>}
          {user && <NavLink to="/tracker">Tracker</NavLink>}
        </nav>

        {/* ── Right side: user widget + mobile hamburger ── */}
        <div className="flex items-center gap-2">

          {/* User widget — always rendered (home page & everywhere) */}
          {!loading && (
            user ? (
              <div className="relative" ref={userMenuRef}>
                <button
                  onClick={() => setUserMenuOpen(s => !s)}
                  className="flex items-center gap-2 bg-white/5 hover:bg-white/10 border border-white/8 hover:border-white/15
                    px-2 py-1.5 rounded-full text-sm cursor-pointer text-white transition-all duration-200"
                  aria-haspopup="true"
                  aria-expanded={userMenuOpen}
                >
                  <div className="w-7 h-7 rounded-full bg-red-500 flex items-center justify-center
                    text-white text-xs font-bold shadow-md ring-2 ring-red-400/40">
                    {userInitial}
                  </div>
                  <span className="hidden sm:inline max-w-[120px] truncate text-white/80 text-xs">
                    {userLabel}
                  </span>
                  <svg
                    className={`h-3.5 w-3.5 text-white/50 transition-transform duration-200 ${userMenuOpen ? "rotate-180" : ""}`}
                    fill="none" viewBox="0 0 24 24" stroke="currentColor"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </button>

                {userMenuOpen && (
                  <div className="user-dropdown" role="menu">
                    <div className="px-4 py-3 border-b border-white/8">
                      <p className="text-xs text-white/40 uppercase tracking-wide mb-0.5">Signed in as</p>
                      <p className="text-sm font-medium text-white truncate">{userLabel}</p>
                    </div>
                    <div className="p-2 space-y-1">
                      <Link
                        to="/home"
                        onClick={() => setUserMenuOpen(false)}
                        className="flex items-center gap-2 w-full px-3 py-2 rounded-lg text-sm text-white/70 hover:text-white hover:bg-white/8 transition-colors"
                      >
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
                        </svg>
                        Home
                      </Link>
                      <Link
                        to="/vote"
                        onClick={() => setUserMenuOpen(false)}
                        className="flex items-center gap-2 w-full px-3 py-2 rounded-lg text-sm text-white/70 hover:text-white hover:bg-white/8 transition-colors"
                      >
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                        </svg>
                        Vote
                      </Link>
                      <Link
                        to="/tracker"
                        onClick={() => setUserMenuOpen(false)}
                        className="flex items-center gap-2 w-full px-3 py-2 rounded-lg text-sm text-white/70 hover:text-white hover:bg-white/8 transition-colors"
                      >
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                        </svg>
                        Tracker
                      </Link>
                    </div>
                    <div className="p-2 border-t border-white/8">
                      <button
                        onClick={handleSignOut}
                        className="w-full flex items-center justify-center gap-2 bg-red-500/10 hover:bg-red-500/20 border border-red-500/20
                          text-red-400 hover:text-red-300 py-2 px-3 rounded-lg font-semibold transition-all duration-200 text-sm"
                      >
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
                        </svg>
                        Sign out
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <Link
                to="/login"
                className="bg-red-500 hover:bg-red-600 text-white px-4 py-2 rounded-full text-sm font-semibold transition-all duration-200 shadow-md hover:shadow-red-500/25"
              >
                Sign In
              </Link>
            )
          )}

          {/* Mobile hamburger — shown on ALL non-auth pages */}
          <button
            className="md:hidden p-2 rounded-lg hover:bg-white/8 text-white/70 hover:text-white transition-colors"
            onClick={() => setOpen(s => !s)}
            aria-label="Toggle menu"
          >
            {open ? (
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            ) : (
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            )}
          </button>
        </div>
      </div>

      {/* ── Mobile dropdown — shown on ALL non-auth pages ── */}
      <div className={`mobile-menu md:hidden ${open ? "open" : ""}`}>
        <NavLink to="/home"  onClick={() => setOpen(false)}>Home</NavLink>
        <NavLink to="/about" onClick={() => setOpen(false)}>About</NavLink>
        <NavLink to="/hours" onClick={() => setOpen(false)}>Hours</NavLink>
        {user && <NavLink to="/vote"    onClick={() => setOpen(false)}>Vote</NavLink>}
        {user && <NavLink to="/tracker" onClick={() => setOpen(false)}>Tracker</NavLink>}
      </div>
    </header>
  );
}
