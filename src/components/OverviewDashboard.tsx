import {
  Activity,
  AlertTriangle,
  Briefcase,
  Building2,
  Calculator,
  CheckCircle2,
  ClipboardCheck,
  Clock,
  FileSpreadsheet,
  FileText,
  FlaskConical,
  IndianRupee,
  Layers,
  MonitorPlay,
  ShieldCheck,
  TrendingUp,
  UserCheck,
  UserPlus,
  Users,
  Zap,
} from 'lucide-react';
import React, { useEffect, useMemo, useState } from 'react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { CANONICAL_CENTRES, CENTRE_MAP, DEPARTMENT_LABELS, ROLE_LABELS } from '../constants/centres';
import { computeInstitutionalAnalytics, maskMobileNumber } from '../lib/analyticsMath';
import type {
  ActivityLog,
  AdmissionRecord,
  Centre,
  CentreId,
  FeeRecoveryRecord,
  NavSection,
  OnlineClassRecord,
  PracticalRecord,
  Student,
  TmaRecord,
  UserAccount,
} from '../types/domain';
import { CampusTwilightArtwork } from './CampusTwilightArtwork';

interface OverviewDashboardProps {
  currentUser: UserAccount;
  centres: Centre[];
  users: UserAccount[];
  students: Student[];
  feeRecords: FeeRecoveryRecord[];
  practicalRecords: PracticalRecord[];
  tmaRecords: TmaRecord[];
  onlineClassRecords: OnlineClassRecord[];
  admissionRecords: AdmissionRecord[];
  activityLogs: ActivityLog[];
  selectedCentreFilter: CentreId | 'all';
  onNavigate: (section: NavSection) => void;
}

const MiniSparkWave: React.FC<{ stroke: string; fillId: string; path: string }> = ({ stroke, fillId, path }) => (
  <svg viewBox="0 0 90 30" className="w-20 h-7 shrink-0 overflow-visible" aria-hidden="true">
    <defs>
      <linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stopColor={stroke} stopOpacity="0.26" />
        <stop offset="100%" stopColor={stroke} stopOpacity="0" />
      </linearGradient>
    </defs>
    <path d={`${path} L 90 30 L 0 30 Z`} fill={`url(#${fillId})`} />
    <path d={path} fill="none" stroke={stroke} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const OverviewDashboard: React.FC<OverviewDashboardProps> = ({
  currentUser,
  centres,
  users,
  students,
  feeRecords,
  admissionRecords,
  activityLogs,
  selectedCentreFilter,
  onNavigate,
}) => {
  const [clockText, setClockText] = useState(() => new Date().toLocaleTimeString('en-IN', { hour12: false }));

  useEffect(() => {
    const timer = setInterval(() => {
      setClockText(new Date().toLocaleTimeString('en-IN', { hour12: false }));
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  const effectiveCentre =
    currentUser.role === 'super_admin' ? selectedCentreFilter : currentUser.centreId;

  const scopedStudents = useMemo(
    () => (effectiveCentre === 'all' ? students : students.filter((s) => s.centreId === effectiveCentre)),
    [students, effectiveCentre],
  );

  const scopedUsers = useMemo(
    () => (effectiveCentre === 'all' ? users : users.filter((u) => u.centreId === effectiveCentre)),
    [users, effectiveCentre],
  );

  const analytics = useMemo(
    () => computeInstitutionalAnalytics(students, feeRecords, admissionRecords, effectiveCentre),
    [students, feeRecords, admissionRecords, effectiveCentre],
  );

  const totalEmployees = scopedUsers.filter((u) => u.role === 'employee' && u.status === 'Active').length;
  const totalCentreHeads = scopedUsers.filter((u) => u.role === 'centre_head' && u.status === 'Active').length;
  const activeCentresCount =
    currentUser.role === 'super_admin'
      ? centres.length > 0
        ? centres.filter((c) => c.status === 'Active').length
        : CANONICAL_CENTRES.length
      : 1;

  const pendingTma = analytics.totalStudents - analytics.tmaSubmittedCount;
  const pendingPractical = analytics.totalStudents - analytics.practicalDoneCount;
  const regularOnlineCount = analytics.regularAttendanceCount;
  const attendanceRate = analytics.attendanceRatePct;

  const totalFeeCollected = analytics.totalFeePaid;
  const totalFeePending = analytics.totalFeePending;

  const branchDistributionData = useMemo(() => {
    return analytics.branchMetrics.map((b) => ({
      name: b.name,
      fullName: b.fullName,
      value: b.students,
      actualCount: b.students,
      percentage: b.percentage,
      color: b.color,
    }));
  }, [analytics.branchMetrics]);

  const centreComparisonData = useMemo(() => {
    return analytics.branchMetrics.map((b) => ({
      name: b.name,
      fullName: b.fullName,
      Students: b.students,
      'TMA Submitted': b.tmaSubmitted,
      'Practical Done': b.practicalDone,
    }));
  }, [analytics.branchMetrics]);

  const feeGraphData = useMemo(() => {
    return analytics.branchMetrics.map((b) => ({
      name: b.name,
      fullName: b.fullName,
      'Paid (Jama)': b.paidFee,
      'Pending (Baki)': b.pendingFee,
      collectionRate: b.collectionRate,
    }));
  }, [analytics.branchMetrics]);

  const departmentPerformanceData = analytics.departmentPerformance;

  const latestRegistrations = useMemo(() => scopedStudents.slice(0, 5), [scopedStudents]);

  const employeeOverview = useMemo(
    () => scopedUsers.filter((u) => u.role === 'employee').slice(0, 6),
    [scopedUsers],
  );

  /* EMPLOYEE OVERVIEW VIEW */
  if (currentUser.role === 'employee') {
    const deptLabel = DEPARTMENT_LABELS[currentUser.department] || currentUser.department;
    return (
      <div className="space-y-6">
        {/* Campus Architectural Hero Banner */}
        <div className="relative overflow-hidden rounded-2xl shadow-xl border border-slate-200/40 min-h-[215px] flex items-center">
          <CampusTwilightArtwork variant="banner" />

          <div className="relative z-10 w-full p-6 sm:p-8 flex flex-col lg:flex-row lg:items-center justify-between gap-6 text-white">
            <div className="max-w-xl">
              <div className="inline-flex items-center gap-2 text-xs font-extrabold uppercase tracking-[0.16em] text-slate-200">
                <span>Welcome To</span>
                <span className="w-6 h-0.5 bg-red-500 rounded-full" />
                <span className="text-[#FBBF24]">{deptLabel} Department</span>
              </div>
              <h2 className="text-2xl sm:text-4xl font-extrabold italic tracking-tight text-white mt-2">
                DATABASE SECURITY
              </h2>
              <p className="text-xs sm:text-sm text-slate-100/90 mt-2">
                Welcome, <strong className="text-[#FBBF24]">{currentUser.fullName}</strong> ({currentUser.centreName}).
                Fill entries once in the Student Excel Sheet (auto-locks after save) or submit your daily department report.
              </p>

              <div className="mt-5 flex flex-wrap gap-2.5">
                <button
                  type="button"
                  onClick={() => onNavigate('student_database')}
                  className="px-4 py-2.5 text-xs font-bold btn-crimson-gloss text-white rounded-xl transition-all whitespace-nowrap"
                >
                  Open Student Excel Sheet
                </button>
                <button
                  type="button"
                  onClick={() => onNavigate(currentUser.department as NavSection)}
                  className="px-4 py-2.5 text-xs font-bold bg-white/15 border border-white/25 hover:bg-white/25 text-white rounded-xl transition-colors whitespace-nowrap backdrop-blur-md"
                >
                  Open {deptLabel} Console
                </button>
                <button
                  type="button"
                  onClick={() => onNavigate('reports')}
                  className="inline-flex items-center gap-1.5 px-4 py-2.5 text-xs font-bold bg-white text-[#0F172A] hover:bg-slate-100 rounded-xl transition-colors whitespace-nowrap shadow-md"
                >
                  <FileText className="w-3.5 h-3.5 text-[#DC2626]" />
                  Send Work Report
                </button>
              </div>
            </div>

            <div className="hidden xl:flex flex-col gap-2.5 bg-[#0C142B]/65 backdrop-blur-md border border-white/15 rounded-2xl p-4 w-72 shrink-0">
              <div className="flex items-center gap-2.5 text-xs font-semibold text-white">
                <Layers className="w-4 h-4 text-[#FBBF24]" />
                <span>Branch-Scoped Excel Workspace</span>
              </div>
              <div className="flex items-center gap-2.5 text-xs font-semibold text-white">
                <ShieldCheck className="w-4 h-4 text-rose-400" />
                <span>Fill-Once Row Lock Security</span>
              </div>
              <div className="flex items-center gap-2.5 text-xs font-semibold text-white">
                <Zap className="w-4 h-4 text-amber-400" />
                <span>Real-Time Staff Reporting</span>
              </div>
              <div className="flex items-center gap-2.5 text-xs font-semibold text-white">
                <Clock className="w-4 h-4 text-emerald-400" />
                <span className="font-mono">{clockText} IST · GPS Active</span>
              </div>
            </div>
          </div>
        </div>

        {/* 3 Sparkline KPI Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="bg-white rounded-2xl border border-rose-200/80 p-4 flex items-center justify-between gap-3 shadow-xs">
            <div className="flex items-center gap-3.5">
              <div className="w-11 h-11 rounded-xl bg-rose-50 border border-rose-100 flex items-center justify-center text-[#DC2626]">
                <Users className="w-5 h-5" />
              </div>
              <div>
                <p className="text-xs font-semibold text-slate-600">Centre Student Roster</p>
                <p className="text-2xl font-extrabold text-[#0F172A] font-mono tabular-nums mt-0.5">
                  {scopedStudents.length}
                </p>
              </div>
            </div>
            <MiniSparkWave stroke="#EF4444" fillId="empSpark1" path="M0 24 Q 20 8, 42 18 T 90 12" />
          </div>

          <div className="bg-white rounded-2xl border border-emerald-200/80 p-4 flex items-center justify-between gap-3 shadow-xs">
            <div className="flex items-center gap-3.5">
              <div className="w-11 h-11 rounded-xl bg-emerald-50 border border-emerald-100 flex items-center justify-center text-emerald-700">
                <Briefcase className="w-5 h-5" />
              </div>
              <div>
                <p className="text-xs font-semibold text-slate-600">Assigned Department</p>
                <p className="text-lg font-extrabold text-[#0F172A] mt-0.5">{deptLabel}</p>
              </div>
            </div>
            <MiniSparkWave stroke="#10B981" fillId="empSpark2" path="M0 22 Q 25 26, 48 12 T 90 8" />
          </div>

          <div className="bg-white rounded-2xl border border-amber-200/80 p-4 flex items-center justify-between gap-3 shadow-xs">
            <div className="flex items-center gap-3.5">
              <div className="w-11 h-11 rounded-xl bg-amber-50 border border-amber-100 flex items-center justify-center text-[#D97706]">
                <ShieldCheck className="w-5 h-5" />
              </div>
              <div>
                <p className="text-xs font-semibold text-slate-600">Branch Geofence</p>
                <p className="text-sm font-extrabold text-emerald-700 mt-0.5">
                  Active at {CENTRE_MAP[currentUser.centreId]?.code}
                </p>
              </div>
            </div>
            <MiniSparkWave stroke="#F59E0B" fillId="empSpark3" path="M0 20 Q 22 6, 50 18 T 90 10" />
          </div>
        </div>

      </div>
    );
  }

  /* LEADERSHIP (SUPER ADMIN & CENTRE HEAD) VIEW */
  return (
    <div className="space-y-6">
      {/* Top Panoramic Campus Hero Banner */}
      <div className="relative overflow-hidden rounded-2xl shadow-xl border border-slate-200/60 min-h-[225px] flex items-center">
        <CampusTwilightArtwork variant="banner" />

        <div className="relative z-10 w-full p-6 sm:p-7 flex flex-col lg:flex-row lg:items-center justify-between gap-6 text-white">
          <div className="max-w-2xl">
            <div className="flex flex-wrap items-center gap-2.5 text-xs font-extrabold uppercase tracking-[0.16em]">
              <span className="text-slate-200">Welcome To</span>
              <span className="w-7 h-0.5 bg-[#EF4444] rounded-full" />
              <span className="text-[#FBBF24]">{ROLE_LABELS[currentUser.role]} Command</span>
              <span aria-hidden="true" className="text-white/30">·</span>
              <span className="inline-flex items-center gap-1 font-mono text-slate-100">
                <Clock className="w-3.5 h-3.5 text-[#FBBF24]" />
                {clockText} IST
              </span>
            </div>

            <h2 className="text-2xl sm:text-4xl font-extrabold italic tracking-tight text-white mt-2 leading-none drop-shadow-md">
              DATABASE <span className="text-white">SECURITY</span>
            </h2>
            <p className="text-xs sm:text-sm text-slate-100/95 mt-2 font-medium">
              {currentUser.role === 'super_admin'
                ? 'One Platform. Four Centres. Complete Control.'
                : `${CENTRE_MAP[currentUser.centreId]?.name} — Exclusive Branch Control & Excel Governance.`}
            </p>

            <div className="mt-5 flex flex-wrap items-center gap-2.5">
              <button
                type="button"
                onClick={() => onNavigate('student_database')}
                className="px-4 py-2.5 text-xs font-bold btn-crimson-gloss text-white rounded-xl transition-all whitespace-nowrap"
              >
                Open Student Excel Sheet
              </button>
              <button
                type="button"
                onClick={() => onNavigate('employee_management')}
                className="px-4 py-2.5 text-xs font-bold bg-white/15 hover:bg-white/25 border border-white/25 text-white rounded-xl transition-colors whitespace-nowrap backdrop-blur-md"
              >
                Manage Branch Staff
              </button>
              <button
                type="button"
                onClick={() => onNavigate('reports')}
                className="px-4 py-2.5 text-xs font-bold bg-white text-[#0F172A] hover:bg-slate-100 rounded-xl transition-colors whitespace-nowrap shadow-md"
              >
                Staff Reports Inbox
              </button>
            </div>
          </div>

          {/* Right Institutional Pillars List inside Translucent Glass Box matching mockup */}
          <div className="hidden xl:flex flex-col gap-2.5 bg-[#0C142B]/70 backdrop-blur-md border border-white/15 rounded-2xl p-4 w-72 shrink-0">
            <div className="flex items-center gap-2.5 text-xs font-semibold text-white">
              <Layers className="w-4 h-4 text-[#FBBF24] shrink-0" />
              <span>Multi-Branch Management</span>
            </div>
            <div className="flex items-center gap-2.5 text-xs font-semibold text-white">
              <ShieldCheck className="w-4 h-4 text-rose-400 shrink-0" />
              <span>Secure &amp; Centralized</span>
            </div>
            <div className="flex items-center gap-2.5 text-xs font-semibold text-white">
              <Zap className="w-4 h-4 text-amber-400 shrink-0" />
              <span>Real-Time Reporting</span>
            </div>
            <div className="flex items-center gap-2.5 text-xs font-semibold text-white">
              <Users className="w-4 h-4 text-rose-300 shrink-0" />
              <span>Complete Staff Governance</span>
            </div>
          </div>
        </div>
      </div>

      {/* Signature 4-Column Sparkline KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white rounded-2xl border border-rose-200/80 p-4 flex items-center justify-between gap-2 shadow-xs">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-11 h-11 rounded-xl bg-rose-50 border border-rose-100 flex items-center justify-center text-[#DC2626] shrink-0">
              <Users className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <p className="text-xs font-semibold text-slate-600 truncate">Total Students</p>
              <p className="text-2xl font-extrabold text-[#0F172A] font-mono tabular-nums leading-tight mt-0.5">
                {scopedStudents.length}
              </p>
              <p className="text-[11px] text-slate-500 truncate">
                {effectiveCentre === 'all' ? 'Across 4 active centres' : CENTRE_MAP[effectiveCentre]?.code}
              </p>
            </div>
          </div>
          <MiniSparkWave stroke="#EF4444" fillId="sparkStudents" path="M0 24 Q 18 12, 38 20 T 90 10" />
        </div>

        <div className="bg-white rounded-2xl border border-emerald-200/80 p-4 flex items-center justify-between gap-2 shadow-xs">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-11 h-11 rounded-xl bg-emerald-50 border border-emerald-100 flex items-center justify-center text-emerald-700 shrink-0">
              <UserCheck className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <p className="text-xs font-semibold text-slate-600 truncate">Staff &amp; Leadership</p>
              <p className="text-xl font-extrabold text-[#0F172A] font-mono tabular-nums leading-tight mt-0.5">
                {totalEmployees} <span className="text-xs font-semibold text-slate-500">Emp</span> · {totalCentreHeads}{' '}
                <span className="text-xs font-semibold text-slate-500">Heads</span>
              </p>
              <p className="text-[11px] text-slate-500 truncate">
                {activeCentresCount} Active {activeCentresCount === 1 ? 'Centre' : 'Centres'}
              </p>
            </div>
          </div>
          <MiniSparkWave stroke="#10B981" fillId="sparkStaff" path="M0 22 Q 22 26, 46 14 T 90 8" />
        </div>

        <div className="bg-white rounded-2xl border border-amber-200/80 p-4 flex items-center justify-between gap-2 shadow-xs">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-11 h-11 rounded-xl bg-amber-50 border border-amber-100 flex items-center justify-center text-[#D97706] shrink-0">
              <IndianRupee className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <p className="text-xs font-semibold text-slate-600 truncate">
                Fee Recovery ({analytics.collectionRatePct}%)
              </p>
              <p className="text-xl font-extrabold text-emerald-700 font-mono tabular-nums leading-tight mt-0.5">
                ₹{totalFeeCollected.toLocaleString('en-IN')}
              </p>
              <p className="text-[11px] text-[#B91C1C] font-mono font-semibold truncate">
                Due: ₹{totalFeePending.toLocaleString('en-IN')}
              </p>
            </div>
          </div>
          <MiniSparkWave stroke="#F59E0B" fillId="sparkFee" path="M0 20 Q 24 6, 48 18 T 90 12" />
        </div>

        <div className="bg-white rounded-2xl border border-violet-200/80 p-4 flex items-center justify-between gap-2 shadow-xs">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-11 h-11 rounded-xl bg-violet-50 border border-violet-100 flex items-center justify-center text-violet-700 shrink-0">
              <MonitorPlay className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <p className="text-xs font-semibold text-slate-600 truncate">Online Attendance</p>
              <p className="text-2xl font-extrabold text-[#0F172A] font-mono tabular-nums leading-tight mt-0.5">
                {attendanceRate}%
              </p>
              <p className="text-[11px] text-slate-500 truncate">{regularOnlineCount} Regular Students</p>
            </div>
          </div>
          <MiniSparkWave stroke="#7C3AED" fillId="sparkOnline" path="M0 24 Q 20 20, 44 10 T 90 14" />
        </div>
      </div>

      {/* 3-Card Row Matching Bottom Section of Dashboard Reference: Branch Distribution Donut + Attendance/Completion Trend + Quick Actions */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
        {/* Branch Distribution Donut Card */}
        <div className="lg:col-span-4 bg-white rounded-2xl border border-slate-200 p-5 shadow-xs flex flex-col justify-between">
          <div className="flex items-center gap-2 mb-3">
            <Building2 className="w-4 h-4 text-[#DC2626]" />
            <h3 className="text-sm font-bold text-[#0F172A]">Branch Distribution</h3>
          </div>

          <div className="flex items-center gap-4">
            <div className="relative w-36 h-36 shrink-0">
              {analytics.totalStudents === 0 ? (
                <div className="w-full h-full rounded-full border-8 border-slate-100 flex flex-col items-center justify-center text-center">
                  <span className="text-lg font-extrabold font-mono text-slate-400">0</span>
                  <span className="text-[10px] font-semibold text-slate-400">Students</span>
                </div>
              ) : (
                <>
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie
                        data={branchDistributionData}
                        dataKey="value"
                        nameKey="name"
                        innerRadius={44}
                        outerRadius={64}
                        paddingAngle={2}
                        stroke="none"
                      >
                        {branchDistributionData.map((entry) => (
                          <Cell key={entry.name} fill={entry.color} />
                        ))}
                      </Pie>
                      <Tooltip
                        formatter={(_v, _name, item) => [
                          `${item.payload.actualCount} students (${item.payload.percentage}%)`,
                          item.payload.fullName,
                        ]}
                      />
                    </PieChart>
                  </ResponsiveContainer>
                  <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
                    <span className="text-lg font-extrabold font-mono text-[#0F172A] leading-none tabular-nums">
                      {String(analytics.totalStudents).padStart(2, '0')}
                    </span>
                    <span className="text-[10px] font-semibold text-slate-500 mt-0.5">Students</span>
                  </div>
                </>
              )}
            </div>

            <div className="flex-1 space-y-2.5">
              {branchDistributionData.map((b) => (
                <div key={b.name} className="flex items-center justify-between text-xs">
                  <div className="flex items-center gap-2 min-w-0">
                    <span
                      className="w-2.5 h-2.5 rounded-full shrink-0"
                      style={{ backgroundColor: b.color }}
                    />
                    <span className="font-mono font-bold text-[#0F172A]">{b.name}</span>
                    <span className="text-[11px] font-mono text-slate-500">({b.actualCount})</span>
                  </div>
                  <span className="font-mono font-bold text-slate-700 tabular-nums">{b.percentage}%</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Smooth Crimson Area Chart */}
        <div className="lg:col-span-5 bg-white rounded-2xl border border-slate-200 p-5 shadow-xs">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <Activity className="w-4 h-4 text-[#DC2626]" />
              <h3 className="text-sm font-bold text-[#0F172A]">Branch Volume &amp; Completion</h3>
            </div>
            <span className="text-[11px] text-slate-500 font-medium">Live Telemetry</span>
          </div>
          <div className="h-44 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={centreComparisonData} margin={{ top: 10, right: 12, left: -18, bottom: 0 }}>
                <defs>
                  <linearGradient id="crimsonAreaFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#DC2626" stopOpacity={0.32} />
                    <stop offset="95%" stopColor="#DC2626" stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
                <XAxis dataKey="name" tick={{ fontSize: 11, fill: '#334155' }} />
                <YAxis tick={{ fontSize: 11, fill: '#334155' }} allowDecimals={false} />
                <Tooltip contentStyle={{ backgroundColor: '#ffffff', borderColor: '#e2e8f0', borderRadius: '0.75rem' }} />
                <Area
                  type="monotone"
                  dataKey="Students"
                  stroke="#DC2626"
                  strokeWidth={2.5}
                  fill="url(#crimsonAreaFill)"
                  dot={{ r: 4, fill: '#DC2626', stroke: '#ffffff', strokeWidth: 2 }}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Quick Actions 2x2 Grid Card */}
        <div className="lg:col-span-3 bg-white rounded-2xl border border-slate-200 p-5 shadow-xs flex flex-col justify-between">
          <div className="flex items-center gap-2 mb-3">
            <Zap className="w-4 h-4 text-[#DC2626]" />
            <h3 className="text-sm font-bold text-[#0F172A]">Quick Actions</h3>
          </div>

          <div className="grid grid-cols-2 gap-2.5">
            <button
              type="button"
              onClick={() => onNavigate('student_database')}
              className="flex flex-col items-center justify-center gap-1.5 p-3 rounded-xl bg-rose-50 hover:bg-rose-100 border border-rose-200/80 text-[#0F172A] transition-colors"
            >
              <FileSpreadsheet className="w-5 h-5 text-[#DC2626]" />
              <span className="text-[11px] font-bold whitespace-nowrap">Excel Sheet</span>
            </button>

            <button
              type="button"
              onClick={() => onNavigate('admission')}
              className="flex flex-col items-center justify-center gap-1.5 p-3 rounded-xl bg-blue-50 hover:bg-blue-100 border border-blue-200/80 text-[#0F172A] transition-colors"
            >
              <UserPlus className="w-5 h-5 text-blue-700" />
              <span className="text-[11px] font-bold whitespace-nowrap">New Admission</span>
            </button>

            <button
              type="button"
              onClick={() => onNavigate('employee_management')}
              className="flex flex-col items-center justify-center gap-1.5 p-3 rounded-xl bg-emerald-50 hover:bg-emerald-100 border border-emerald-200/80 text-[#0F172A] transition-colors"
            >
              <Users className="w-5 h-5 text-emerald-700" />
              <span className="text-[11px] font-bold whitespace-nowrap">Add Staff</span>
            </button>

            <button
              type="button"
              onClick={() => onNavigate('reports')}
              className="flex flex-col items-center justify-center gap-1.5 p-3 rounded-xl bg-amber-50 hover:bg-amber-100 border border-amber-200/80 text-[#0F172A] transition-colors"
            >
              <FileText className="w-5 h-5 text-[#D97706]" />
              <span className="text-[11px] font-bold whitespace-nowrap">Work Reports</span>
            </button>
          </div>
        </div>
      </div>
      {/* Fee Recovery Financial Graph & Logic/Mathematical Reasoning Panel */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
        <div className="lg:col-span-7 bg-white rounded-2xl border border-slate-200 p-5 shadow-xs">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
            <div>
              <div className="flex items-center gap-2">
                <TrendingUp className="w-4 h-4 text-emerald-700" />
                <h3 className="text-sm font-bold text-[#0F172A]">
                  Centre-Wise Fee Recovery Math (Paid vs. Pending)
                </h3>
              </div>
              <p className="text-xs text-slate-600 mt-0.5">
                Billed: ₹{analytics.totalFeeBilled.toLocaleString('en-IN')} · Collection Rate:{' '}
                <strong className="text-emerald-700 font-mono">{analytics.collectionRatePct}%</strong> · Avg Paid/Student: ₹
                {analytics.avgFeePerStudent.toLocaleString('en-IN')}
              </p>
            </div>
            <div className="flex items-center gap-2 text-[11px] font-mono">
              <span className="px-2 py-0.5 rounded bg-emerald-50 text-emerald-800 border border-emerald-200 font-bold">
                {analytics.paidCount} Paid
              </span>
              <span className="px-2 py-0.5 rounded bg-amber-50 text-amber-800 border border-amber-200 font-bold">
                {analytics.partialCount} Partial
              </span>
              <span className="px-2 py-0.5 rounded bg-rose-50 text-rose-800 border border-rose-200 font-bold">
                {analytics.pendingCount + analytics.overdueCount} Due
              </span>
            </div>
          </div>
          <div className="h-56 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={feeGraphData} margin={{ top: 8, right: 12, left: 6, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
                <XAxis dataKey="name" tick={{ fontSize: 11, fill: '#1E293B' }} />
                <YAxis
                  tick={{ fontSize: 11, fill: '#1E293B' }}
                  tickFormatter={(v) => `₹${Number(v) >= 1000 ? `${Math.round(Number(v) / 1000)}k` : v}`}
                />
                <Tooltip
                  formatter={(value: unknown) => `₹${Number(value || 0).toLocaleString('en-IN')}`}
                  contentStyle={{
                    backgroundColor: '#ffffff',
                    borderColor: '#cbd5e1',
                    color: '#0F172A',
                    borderRadius: '0.75rem',
                  }}
                />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar dataKey="Paid (Jama)" fill="#059669" radius={[4, 4, 0, 0]} />
                <Bar dataKey="Pending (Baki)" fill="#DC2626" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="lg:col-span-5 bg-white rounded-2xl border border-slate-200 p-5 shadow-xs flex flex-col">
          <div className="flex items-center justify-between gap-2 mb-3">
            <div className="flex items-center gap-2">
              <Calculator className="w-4 h-4 text-[#DC2626]" />
              <h3 className="text-sm font-bold text-[#0F172A]">Logic &amp; Mathematical Insights</h3>
            </div>
            <span className="text-[11px] font-mono font-bold text-slate-500">Live Ratio Audit</span>
          </div>
          <div className="space-y-2.5 flex-1">
            {analytics.reasoningInsights.map((insight) => (
              <div
                key={insight.id}
                className={`p-3 rounded-xl border text-xs ${
                  insight.severity === 'good'
                    ? 'bg-emerald-50/75 border-emerald-200 text-emerald-950'
                    : insight.severity === 'critical'
                      ? 'bg-rose-50/75 border-rose-200 text-rose-950'
                      : 'bg-amber-50/75 border-amber-200 text-amber-950'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="inline-flex items-center gap-1.5 font-bold">
                    {insight.severity === 'good' ? (
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-700 shrink-0" />
                    ) : (
                      <AlertTriangle
                        className={`w-3.5 h-3.5 shrink-0 ${
                          insight.severity === 'critical' ? 'text-rose-700' : 'text-amber-700'
                        }`}
                      />
                    )}
                    {insight.title}
                  </span>
                  <span className="font-mono font-extrabold text-[11px] shrink-0">{insight.metric}</span>
                </div>
                <p className="mt-1 text-[11px] leading-relaxed opacity-90">{insight.explanation}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
      {/* Department-Wise & Secondary Operational Metrics */}
      <div className={`grid grid-cols-1 sm:grid-cols-3 ${currentUser.role === 'super_admin' ? 'lg:grid-cols-4' : 'lg:grid-cols-3'} gap-4`}>
        <button
          type="button"
          onClick={() => onNavigate('admission')}
          className="text-left bg-white rounded-2xl border border-slate-200 p-4 hover:border-[#DC2626] transition-colors shadow-2xs"
        >
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-600">Admissions</span>
            <Building2 className="w-4 h-4 text-[#0F172A]" />
          </div>
          <p className="text-xl font-extrabold text-[#0F172A] font-mono tabular-nums mt-1.5">{scopedStudents.length}</p>
        </button>

        <button
          type="button"
          onClick={() => onNavigate('tma')}
          className="text-left bg-white rounded-2xl border border-slate-200 p-4 hover:border-[#F59E0B] transition-colors shadow-2xs"
        >
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-600">Pending TMA</span>
            <ClipboardCheck className="w-4 h-4 text-[#D97706]" />
          </div>
          <p className="text-xl font-extrabold text-[#D97706] font-mono tabular-nums mt-1.5">{pendingTma}</p>
        </button>

        <button
          type="button"
          onClick={() => onNavigate('practical')}
          className="text-left bg-white rounded-2xl border border-slate-200 p-4 hover:border-[#DC2626] transition-colors shadow-2xs"
        >
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-600">Pending Practical</span>
            <FlaskConical className="w-4 h-4 text-[#DC2626]" />
          </div>
          <p className="text-xl font-extrabold text-[#DC2626] font-mono tabular-nums mt-1.5">{pendingPractical}</p>
        </button>

        {currentUser.role === 'super_admin' && (
          <button
            type="button"
            onClick={() => onNavigate('activity_logs')}
            className="text-left bg-white rounded-2xl border border-slate-200 p-4 hover:border-emerald-600 transition-colors shadow-2xs"
          >
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-slate-600">Audit Events</span>
              <ShieldCheck className="w-4 h-4 text-emerald-700" />
            </div>
            <p className="text-xl font-extrabold text-[#0F172A] font-mono tabular-nums mt-1.5">{activityLogs.length}</p>
          </button>
        )}
      </div>

      {/* Department Performance BarChart & Bottom Live Lists */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
        <div className="lg:col-span-6 bg-white text-[#0F172A] rounded-2xl border border-slate-200 p-5 shadow-xs">
          <h3 className="text-sm font-bold text-[#0F172A]">Department-Wise Performance</h3>
          <p className="text-xs text-slate-600 mt-0.5 mb-4">
            Completed vs. pending operations across all 5 departments
          </p>
          <div className="h-60 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={departmentPerformanceData} margin={{ top: 8, right: 12, left: -12, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
                <XAxis dataKey="department" tick={{ fontSize: 11, fill: '#1E293B' }} />
                <YAxis tick={{ fontSize: 12, fill: '#1E293B' }} allowDecimals={false} />
                <Tooltip contentStyle={{ backgroundColor: '#ffffff', borderColor: '#cbd5e1', color: '#0F172A', borderRadius: '0.75rem' }} />
                <Legend wrapperStyle={{ fontSize: 12, color: '#0F172A' }} />
                <Bar dataKey="Completed" fill="#DC2626" radius={[4, 4, 0, 0]} />
                <Bar dataKey="Pending" fill="#F59E0B" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="lg:col-span-6 grid grid-cols-1 sm:grid-cols-2 gap-5">
          <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-xs">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-bold text-[#0F172A]">Latest Registrations</h3>
              <button
                type="button"
                onClick={() => onNavigate('student_database')}
                className="text-xs font-bold text-[#B91C1C] hover:underline"
              >
                Excel Sheet
              </button>
            </div>
            {latestRegistrations.length === 0 ? (
              <p className="text-xs text-slate-600 py-4">No students registered yet.</p>
            ) : (
              <div className="divide-y divide-slate-100">
                {latestRegistrations.map((s) => (
                  <div key={s.studentId} className="py-2.5 flex items-center justify-between gap-2 text-xs">
                    <div className="min-w-0">
                      <p className="font-semibold text-[#0F172A] truncate">
                        #{String(s.serialNumber).padStart(3, '0')} · {s.studentName}
                      </p>
                      <p className="text-[11px] font-mono text-slate-500">
                        {maskMobileNumber(s.mobileNumber)} · {CENTRE_MAP[s.centreId]?.code}
                      </p>
                    </div>
                    <span className="font-mono text-[11px] text-slate-500 shrink-0">{s.admissionDate}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-xs">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-bold text-[#0F172A]">Branch Staff</h3>
              <button
                type="button"
                onClick={() => onNavigate('employee_management')}
                className="text-xs font-bold text-[#B91C1C] hover:underline"
              >
                Manage
              </button>
            </div>
            {employeeOverview.length === 0 ? (
              <p className="text-xs text-slate-600 py-4">No employees provisioned in this scope.</p>
            ) : (
              <div className="divide-y divide-slate-100">
                {employeeOverview.map((emp) => (
                  <div key={emp.uid} className="py-2.5 flex items-center justify-between gap-2 text-xs">
                    <div className="min-w-0">
                      <p className="font-semibold text-[#0F172A] truncate">{emp.fullName}</p>
                      <p className="text-[11px] text-slate-600">
                        {DEPARTMENT_LABELS[emp.department]} · {CENTRE_MAP[emp.centreId]?.code}
                      </p>
                    </div>
                    <span
                      className={`text-[11px] font-bold ${
                        emp.status === 'Active' ? 'text-emerald-700' : 'text-red-700'
                      }`}
                    >
                      {emp.status}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
