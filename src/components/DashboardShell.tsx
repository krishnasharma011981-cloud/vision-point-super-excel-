import {
  Activity,
  BarChart3,
  Bell,
  Building2,
  ClipboardCheck,
  Crown,
  Database,
  Flame,
  FlaskConical,
  IndianRupee,
  LayoutDashboard,
  LogOut,
  Menu,
  MessageSquare,
  MonitorPlay,
  Radio,
  Search,
  Settings,
  User,
  UserCog,
  UserPlus,
  X,
} from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';
import { CANONICAL_CENTRES, DEPARTMENT_LABELS, ROLE_LABELS, SIDEBAR_ITEMS } from '../constants/centres';
import { markNotificationRead } from '../services/firestoreService';
import type { CentreId, NavSection, NotificationItem, UserAccount } from '../types/domain';

interface DashboardShellProps {
  currentUser: UserAccount;
  activeSection: NavSection;
  selectedCentreFilter: CentreId | 'all';
  globalSearch: string;
  notifications: NotificationItem[];
  unreadCommsCount?: number;
  isWalkieLive?: boolean;
  onSelectSection: (section: NavSection) => void;
  onChangeCentreFilter: (centreId: CentreId | 'all') => void;
  onChangeGlobalSearch: (value: string) => void;
  onLogout: () => void;
  children: React.ReactNode;
}

const SHUKRA_LOGO_PATH = '/assets/aistudio/Chat-GPT-Image-Sep-16-2026-06-23-59-PM_a9ff6c17.png';

const SECTION_ICONS: Record<NavSection, React.FC<{ className?: string }>> = {
  overview: LayoutDashboard,
  communication: Radio,
  centre_management: Building2,
  student_database: Database,
  fee_recovery: IndianRupee,
  practical: FlaskConical,
  tma: ClipboardCheck,
  online_classes: MonitorPlay,
  admission: UserPlus,
  employee_management: UserCog,
  reports: BarChart3,
  settings: Settings,
  activity_logs: Activity,
};

export function canUserAccessSection(user: UserAccount, section: NavSection): boolean {
  if (section === 'activity_logs') return user.role === 'super_admin';
  if (user.role === 'super_admin') return true;
  if (user.role === 'centre_head') return true;
  if (
    section === 'overview' ||
    section === 'communication' ||
    section === 'student_database' ||
    section === 'reports' ||
    section === 'settings'
  ) {
    return true;
  }
  if (section === user.department) return true;
  return false;
}

export const DashboardShell: React.FC<DashboardShellProps> = ({
  currentUser,
  activeSection,
  selectedCentreFilter,
  globalSearch,
  notifications,
  unreadCommsCount = 0,
  isWalkieLive = false,
  onSelectSection,
  onChangeCentreFilter,
  onChangeGlobalSearch,
  onLogout,
  children,
}) => {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [showNotifs, setShowNotifs] = useState(false);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  const visibleNavItems = SIDEBAR_ITEMS.filter((item) => canUserAccessSection(currentUser, item.id));
  const unreadCount = notifications.filter((n) => !n.read).length;

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        searchInputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const userInitials = currentUser.fullName
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() || '')
    .join('');

  const sidebarContent = (
    <div className="flex flex-col h-full glass-sidebar text-white select-none">
      {/* Brand Lockup matching dashboard reference */}
      <div className="px-5 py-4 border-b border-red-400/15">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-[#EF4444] to-[#991B1B] border border-red-300/40 flex items-center justify-center text-white shrink-0 shadow-[0_0_20px_rgba(220,38,38,0.45)]">
            <Flame className="w-5 h-5" />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-extrabold text-white tracking-tight truncate">DATABASE</p>
            <p className="text-[11px] font-extrabold text-[#FBBF24] tracking-wider uppercase truncate">
              SECURITY
            </p>
          </div>
        </div>
      </div>

      {/* Active Scope Strip */}
      <div className="px-4 py-3 border-b border-red-400/15">
        <p className="text-[10px] font-bold uppercase tracking-widest text-slate-300/80 mb-1.5">Active Scope</p>
        <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-[#270D19]/80 border border-red-400/35 shadow-inner">
          <Crown className="w-3.5 h-3.5 text-[#FBBF24] shrink-0" />
          <p className="text-xs font-semibold text-white truncate">
            {currentUser.role === 'super_admin' ? 'All 4 Centres · Super Admin' : currentUser.centreName}
          </p>
        </div>
      </div>

      {/* Navigation Links */}
      <nav className="flex-1 overflow-y-auto glass-scrollbar px-3 py-3.5 space-y-1">
        {visibleNavItems.map((item) => {
          const Icon = SECTION_ICONS[item.id];
          const active = activeSection === item.id;
          const label =
            item.id === 'communication' && currentUser.role === 'super_admin'
              ? 'Staff Comms & Walkie'
              : item.label;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => {
                onSelectSection(item.id);
                setMobileMenuOpen(false);
              }}
              className={`w-full flex items-center justify-between gap-2 px-3.5 py-2.5 rounded-xl text-xs font-semibold transition-all whitespace-nowrap ${
                active
                  ? 'bg-gradient-to-r from-[#DC2626]/90 via-[#B91C1C]/75 to-[#7F1D1D]/55 border border-red-400/50 text-white font-bold shadow-[0_6px_20px_rgba(220,38,38,0.38)]'
                  : 'text-slate-200/90 hover:bg-white/10 hover:text-white border border-transparent'
              }`}
            >
              <span className="flex items-center gap-3 min-w-0">
                <Icon className={`w-4 h-4 shrink-0 ${active ? 'text-white' : 'text-slate-300/85'}`} />
                <span className="truncate">{label}</span>
              </span>
              {item.id === 'communication' && unreadCommsCount > 0 && (
                <span className="px-1.5 py-0.5 rounded-md bg-amber-400 text-[#0F172A] text-[10px] font-extrabold font-mono tabular-nums shrink-0">
                  {unreadCommsCount}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      {/* Powered By Shukra Infotech White Card */}
      <div className="px-3.5 py-3 border-t border-red-400/15">
        <div className="bg-white text-[#0F172A] rounded-xl border border-slate-200 px-3 py-2.5 flex flex-col items-center shadow-lg">
          <span className="text-[9px] font-extrabold uppercase tracking-[0.18em] text-[#B91C1C]">
            Powered By
          </span>
          <img
            src={SHUKRA_LOGO_PATH}
            alt="Shukra Infotech"
            referrerPolicy="no-referrer"
            className="h-10 w-full object-contain mt-0.5"
          />
        </div>
      </div>

      {/* User Identity Footer */}
      <div className="p-4 border-t border-red-400/15 bg-[#120710]/65 flex items-center gap-3">
        <div className="w-9 h-9 rounded-full bg-gradient-to-br from-[#EF4444] to-[#991B1B] border border-red-300/50 flex items-center justify-center text-xs font-extrabold text-white shrink-0">
          {userInitials || 'VP'}
        </div>
        <div className="min-w-0">
          <p className="text-xs font-bold text-white truncate">{currentUser.fullName}</p>
          <p className="text-[11px] font-semibold text-[#FBBF24] truncate">
            {ROLE_LABELS[currentUser.role]} · {DEPARTMENT_LABELS[currentUser.department]}
          </p>
          <p className="text-[10px] text-slate-300/80 truncate">{currentUser.centreName}</p>
        </div>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen flex light-grid-bg text-[#0F172A]">
      {/* Desktop Fixed Sidebar */}
      <aside className="hidden lg:block w-68 shrink-0 no-print">
        <div className="sticky top-0 h-screen">{sidebarContent}</div>
      </aside>

      {/* Mobile Drawer */}
      {mobileMenuOpen && (
        <div className="fixed inset-0 z-50 lg:hidden flex">
          <div className="fixed inset-0 bg-[#0A0E1D]/75 backdrop-blur-sm" onClick={() => setMobileMenuOpen(false)} />
          <div className="relative w-68 max-w-[82vw] h-full z-10 shadow-2xl">
            <button
              type="button"
              onClick={() => setMobileMenuOpen(false)}
              className="absolute top-4 right-3 text-slate-200 hover:text-white p-1"
              aria-label="Close navigation menu"
            >
              <X className="w-5 h-5" />
            </button>
            {sidebarContent}
          </div>
        </div>
      )}

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Crisp Frosted Top Header */}
        <header className="sticky top-0 z-30 bg-white/92 backdrop-blur-xl text-[#0F172A] border-b border-slate-200/90 px-4 sm:px-6 py-3 flex items-center justify-between gap-4 no-print shadow-2xs">
          <div className="flex items-center gap-3 flex-1 min-w-0">
            <button
              type="button"
              onClick={() => setMobileMenuOpen(true)}
              className="lg:hidden p-2 text-[#0F172A] hover:bg-slate-100 rounded-lg border border-slate-300 bg-white"
              aria-label="Open navigation menu"
            >
              <Menu className="w-5 h-5" />
            </button>

            <div className="relative flex-1 max-w-lg">
              <Search className="w-4 h-4 text-[#DC2626] absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                ref={searchInputRef}
                type="text"
                value={globalSearch}
                onChange={(e) => onChangeGlobalSearch(e.target.value)}
                placeholder="Search students or staff by name, mobile, subject..."
                className="w-full pl-10 pr-16 py-2 text-xs sm:text-sm bg-white border border-slate-200 rounded-xl text-[#0F172A] placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-[#DC2626]/30 focus:border-[#DC2626] shadow-2xs"
              />
              <span className="hidden sm:inline-flex items-center px-1.5 py-0.5 text-[10px] font-mono font-semibold text-slate-500 bg-slate-100 border border-slate-200 rounded absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none">
                Ctrl + K
              </span>
            </div>
          </div>

          <div className="flex items-center gap-2.5 shrink-0">
            {currentUser.role === 'super_admin' && (
              <div className="hidden sm:flex items-center gap-1.5 bg-white border border-slate-200 rounded-xl px-2.5 py-1.5 shadow-2xs">
                <Building2 className="w-3.5 h-3.5 text-slate-600 shrink-0" />
                <select
                  value={selectedCentreFilter}
                  onChange={(e) => onChangeCentreFilter(e.target.value as CentreId | 'all')}
                  aria-label="Global Centre Selector"
                  className="text-xs font-semibold bg-transparent text-[#0F172A] max-w-[205px] focus:outline-none"
                >
                  <option value="all">ALL CENTRES (4 Branches)</option>
                  {CANONICAL_CENTRES.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {/* Quick Sir Connect / Walkie Button */}
            <button
              type="button"
              onClick={() => onSelectSection('communication')}
              className={`relative p-2 rounded-xl border shadow-2xs transition-colors ${
                isWalkieLive
                  ? 'bg-[#DC2626] text-white border-[#DC2626]'
                  : 'bg-white text-[#0F172A] hover:bg-slate-100 border-slate-200'
              }`}
              aria-label="Open Sir Connect & Walkie-Talkie"
              title="Open Communications & Walkie-Talkie"
            >
              <MessageSquare className="w-4 h-4" />
              {unreadCommsCount > 0 && (
                <span className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-amber-500 text-[#0F172A] text-[10px] font-extrabold flex items-center justify-center font-mono shadow-xs">
                  {unreadCommsCount}
                </span>
              )}
            </button>

            {/* Notifications */}
            <div className="relative">
              <button
                type="button"
                onClick={() => setShowNotifs((prev) => !prev)}
                className="relative p-2 text-[#0F172A] hover:bg-slate-100 bg-white rounded-xl border border-slate-200 shadow-2xs"
                aria-label="Notifications"
              >
                <Bell className="w-4 h-4" />
                {unreadCount > 0 && (
                  <span className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-[#DC2626] text-white text-[10px] font-extrabold flex items-center justify-center font-mono shadow-xs">
                    {unreadCount}
                  </span>
                )}
              </button>

              {showNotifs && (
                <div className="absolute right-0 mt-2 w-80 bg-white text-[#0F172A] rounded-2xl border border-slate-200 shadow-2xl z-40 p-3.5">
                  <div className="flex items-center justify-between pb-2 border-b border-slate-200">
                    <span className="text-xs font-bold text-[#0F172A]">Notifications</span>
                    <button
                      type="button"
                      onClick={() => setShowNotifs(false)}
                      className="text-xs font-medium text-slate-600 hover:text-[#0F172A]"
                    >
                      Close
                    </button>
                  </div>
                  <div className="max-h-64 overflow-y-auto divide-y divide-slate-100 mt-1">
                    {notifications.length === 0 ? (
                      <p className="py-6 text-center text-xs text-slate-600">No notifications right now.</p>
                    ) : (
                      notifications.slice(0, 8).map((n) => (
                        <button
                          key={n.id}
                          type="button"
                          onClick={() => n.id && !n.read && markNotificationRead(n.id).catch(() => {})}
                          className={`w-full text-left py-2.5 px-1 text-xs ${n.read ? 'opacity-65' : 'font-medium'}`}
                        >
                          <p className="text-[#0F172A] font-semibold">{n.title}</p>
                          <p className="text-slate-600 mt-0.5 text-[11px]">{n.message}</p>
                        </button>
                      ))
                    )}
                  </div>
                </div>
              )}
            </div>

            <button
              type="button"
              onClick={() => onSelectSection('settings')}
              className="hidden md:inline-flex items-center gap-2 px-3 py-1.5 text-xs font-semibold text-[#0F172A] bg-white hover:bg-slate-50 rounded-xl border border-slate-200 whitespace-nowrap shadow-2xs"
            >
              <User className="w-3.5 h-3.5 text-slate-600" />
              <span className="truncate max-w-[130px]">{currentUser.fullName}</span>
            </button>

            <button
              type="button"
              onClick={onLogout}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-bold text-[#B91C1C] bg-rose-50 hover:bg-rose-100 border border-rose-200 rounded-xl transition-colors whitespace-nowrap shrink-0"
            >
              <LogOut className="w-3.5 h-3.5" />
              Logout
            </button>
          </div>
        </header>

        {/* Mobile Super Admin Centre Selector */}
        {currentUser.role === 'super_admin' && (
          <div className="sm:hidden px-4 py-2 bg-white border-b border-slate-200 no-print">
            <select
              value={selectedCentreFilter}
              onChange={(e) => onChangeCentreFilter(e.target.value as CentreId | 'all')}
              className="w-full px-3 py-1.5 text-xs font-semibold bg-white border border-slate-300 rounded-lg text-[#0F172A]"
            >
              <option value="all">ALL CENTRES (4 Branches)</option>
              {CANONICAL_CENTRES.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
        )}

        {/* Main Viewport */}
        <main className="flex-1 p-4 sm:p-6 max-w-[1440px] w-full mx-auto">{children}</main>

        {/* Clean Institutional Footer with Crimson Architectural Corner Trim */}
        <footer className="relative overflow-hidden border-t border-slate-200 bg-white/95 px-6 py-4 flex flex-col sm:flex-row items-center justify-between gap-4 no-print">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute -left-8 -bottom-10 w-64 h-16 bg-gradient-to-r from-[#DC2626] via-[#EF4444]/60 to-transparent rounded-full blur-md opacity-25"
          />
          <div className="relative z-10 text-xs text-slate-600">
            <strong className="text-[#0F172A] font-extrabold">DATABASE SECURITY</strong>
            <span className="mx-1.5 text-slate-400">—</span>
            <span>Ashish Pandey&apos;s Multi-Centre Security Portal</span>
          </div>
          <div className="relative z-10 flex items-center gap-3">
            <span className="text-[11px] font-bold text-[#B91C1C]">Powered by</span>
            <img
              src={SHUKRA_LOGO_PATH}
              alt="Shukra Infotech"
              referrerPolicy="no-referrer"
              className="h-8 w-auto object-contain"
            />
          </div>
        </footer>
      </div>
    </div>
  );
};
