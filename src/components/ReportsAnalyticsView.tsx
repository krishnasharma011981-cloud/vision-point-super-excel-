import {
  BarChart3,
  CheckCircle2,
  Download,
  FileSpreadsheet,
  FileText,
  Printer,
  Search,
  Send,
  X,
} from 'lucide-react';
import React, { useMemo, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { CANONICAL_CENTRES, CENTRE_MAP, DEPARTMENT_LABELS, DEPARTMENTS } from '../constants/centres';
import { computeInstitutionalAnalytics, reconcileFeeNumbers } from '../lib/analyticsMath';
import { exportToCsv, exportToExcel, formatDateTime } from '../lib/csvUtils';
import { reviewEmployeeReport, submitEmployeeReport } from '../services/firestoreService';
import type {
  AdmissionRecord,
  CentreId,
  EmployeeReport,
  EmployeeReportStatus,
  FeeRecoveryRecord,
  OnlineClassRecord,
  PracticalRecord,
  Student,
  TmaRecord,
  UserAccount,
  UserDepartment,
} from '../types/domain';

interface ReportsAnalyticsViewProps {
  currentUser: UserAccount;
  students: Student[];
  users: UserAccount[];
  feeRecords: FeeRecoveryRecord[];
  practicalRecords: PracticalRecord[];
  tmaRecords: TmaRecord[];
  onlineClassRecords: OnlineClassRecord[];
  admissionRecords: AdmissionRecord[];
  employeeReports: EmployeeReport[];
  selectedCentreFilter: CentreId | 'all';
  onNotify: (title: string, description: string, variant: 'success' | 'error' | 'warning' | 'info') => void;
}

type ReportType =
  | 'centre_summary'
  | 'fee_recovery'
  | 'practical'
  | 'tma'
  | 'online_classes'
  | 'admission'
  | 'employee_performance';

export const ReportsAnalyticsView: React.FC<ReportsAnalyticsViewProps> = ({
  currentUser,
  students,
  users,
  feeRecords,
  practicalRecords,
  tmaRecords,
  onlineClassRecords,
  admissionRecords,
  employeeReports,
  selectedCentreFilter,
  onNotify,
}) => {
  const [activeTab, setActiveTab] = useState<'work_reports' | 'analytics'>(
    currentUser.role === 'employee' ? 'work_reports' : 'work_reports',
  );

  // Employee Work Report submission state
  const [reportDate, setReportDate] = useState(new Date().toISOString().slice(0, 10));
  const [reportTitle, setReportTitle] = useState('');
  const [reportSummary, setReportSummary] = useState('');
  const [tasksCompleted, setTasksCompleted] = useState('5');
  const [studentsHandled, setStudentsHandled] = useState('10');
  const [pendingIssues, setPendingIssues] = useState('');
  const [submittingReport, setSubmittingReport] = useState(false);

  // Review modal state (Centre Head / Super Admin)
  const [reviewingReport, setReviewingReport] = useState<EmployeeReport | null>(null);
  const [reviewStatus, setReviewStatus] = useState<EmployeeReportStatus>('Reviewed');
  const [reviewNote, setReviewNote] = useState('');
  const [savingReview, setSavingReview] = useState(false);

  // Operational Analytics filters
  const defaultReport: ReportType =
    currentUser.role === 'employee'
      ? (currentUser.department as ReportType)
      : 'centre_summary';

  const [reportType, setReportType] = useState<ReportType>(defaultReport);
  const [centreFilter, setCentreFilter] = useState<CentreId | 'all'>(
    currentUser.role === 'super_admin' ? selectedCentreFilter : currentUser.centreId,
  );
  const [deptFilter, setDeptFilter] = useState<UserDepartment>(
    currentUser.role === 'employee' ? currentUser.department : 'all',
  );
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [search, setSearch] = useState('');

  const effectiveCentre =
    currentUser.role === 'super_admin'
      ? selectedCentreFilter !== 'all'
        ? selectedCentreFilter
        : centreFilter
      : currentUser.centreId;

  const filteredWorkReports = useMemo(() => {
    return employeeReports
      .filter((r) => (effectiveCentre === 'all' ? true : r.centreId === effectiveCentre))
      .filter((r) => (deptFilter === 'all' ? true : r.department === deptFilter))
      .filter((r) => (!dateFrom ? true : r.reportDate >= dateFrom))
      .filter((r) => (!dateTo ? true : r.reportDate <= dateTo))
      .filter((r) => {
        if (!search.trim()) return true;
        const q = search.trim().toLowerCase();
        return (
          r.title.toLowerCase().includes(q) ||
          r.summary.toLowerCase().includes(q) ||
          r.employeeName.toLowerCase().includes(q) ||
          r.employeeEmail.toLowerCase().includes(q)
        );
      });
  }, [employeeReports, effectiveCentre, deptFilter, dateFrom, dateTo, search]);

  const handleSubmitWorkReport = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!reportTitle.trim() || !reportSummary.trim()) {
      onNotify('Missing Details', 'Please provide both a report subject and work summary.', 'error');
      return;
    }
    setSubmittingReport(true);
    try {
      await submitEmployeeReport(
        {
          reportDate,
          title: reportTitle,
          summary: reportSummary,
          tasksCompleted: Number(tasksCompleted) || 0,
          studentsHandled: Number(studentsHandled) || 0,
          pendingIssues,
        },
        currentUser,
      );
      onNotify(
        'Work Report Sent',
        `Your ${DEPARTMENT_LABELS[currentUser.department]} report has been sent to Centre Head & Super Admin.`,
        'success',
      );
      setReportTitle('');
      setReportSummary('');
      setPendingIssues('');
    } catch (err) {
      onNotify('Submission Failed', err instanceof Error ? err.message : 'Unable to send report.', 'error');
    } finally {
      setSubmittingReport(false);
    }
  };

  const handleSaveReview = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!reviewingReport) return;
    setSavingReview(true);
    try {
      await reviewEmployeeReport(
        reviewingReport.reportId,
        reviewStatus,
        reviewNote,
        currentUser,
        reviewingReport.centreId,
      );
      onNotify('Report Updated', `Marked report as ${reviewStatus}.`, 'success');
      setReviewingReport(null);
      setReviewNote('');
    } catch (err) {
      onNotify('Review Failed', err instanceof Error ? err.message : 'Unable to update report.', 'error');
    } finally {
      setSavingReview(false);
    }
  };

  const allowedReports: Array<{ id: ReportType; label: string }> = useMemo(() => {
    if (currentUser.role === 'employee') {
      return [{ id: currentUser.department as ReportType, label: `${DEPARTMENT_LABELS[currentUser.department]} Report` }];
    }
    return [
      { id: 'centre_summary', label: 'Centre-Wise Student Count' },
      { id: 'fee_recovery', label: 'Fee Recovery Report' },
      { id: 'practical', label: 'Practical Completion' },
      { id: 'tma', label: 'TMA Submission' },
      { id: 'online_classes', label: 'Online Class Attendance' },
      { id: 'admission', label: 'Admission Statistics' },
      { id: 'employee_performance', label: 'Employee Performance' },
    ];
  }, [currentUser]);

  const filteredStudents = useMemo(() => {
    return students
      .filter((s) => (effectiveCentre === 'all' ? true : s.centreId === effectiveCentre))
      .filter((s) => (!dateFrom ? true : s.admissionDate >= dateFrom))
      .filter((s) => (!dateTo ? true : s.admissionDate <= dateTo))
      .filter((s) => {
        if (!search.trim()) return true;
        const q = search.trim().toLowerCase();
        return s.studentName.toLowerCase().includes(q) || s.studentId.toLowerCase().includes(q);
      });
  }, [students, effectiveCentre, dateFrom, dateTo, search]);

  const analytics = useMemo(
    () => computeInstitutionalAnalytics(filteredStudents, feeRecords, admissionRecords, effectiveCentre),
    [filteredStudents, feeRecords, admissionRecords, effectiveCentre],
  );

  const reportPayload = useMemo((): { headers: string[]; rows: Array<Array<string | number>> } => {
    if (reportType === 'centre_summary') {
      const feeMap = new Map(feeRecords.map((r) => [r.studentId, r]));
      const targetCentres =
        effectiveCentre === 'all' ? CANONICAL_CENTRES : CANONICAL_CENTRES.filter((c) => c.id === effectiveCentre);
      return {
        headers: [
          'Centre Code',
          'Centre Name',
          'Total Students',
          'Total Fee (₹)',
          'Paid Jama (₹)',
          'Pending Baki (₹)',
          'Collection %',
          'TMA Submitted',
          'Practical Done',
          'Regular Classes',
        ],
        rows: targetCentres.map((c) => {
          const cs = filteredStudents.filter((s) => s.centreId === c.id);
          let tot = 0;
          let paid = 0;
          let pend = 0;
          for (const s of cs) {
            const f = feeMap.get(s.studentId);
            if (f) {
              tot += f.totalFee;
              paid += f.paidAmount;
              pend += f.pendingAmount;
            }
          }
          const pct = tot > 0 ? Math.round((paid / tot) * 100) : 0;
          return [
            c.code,
            c.name,
            cs.length,
            tot,
            paid,
            pend,
            `${pct}%`,
            cs.filter((s) => s.tmaStatus === 'Submitted').length,
            cs.filter((s) => s.practicalStatus === 'Completed').length,
            cs.filter((s) => s.classAttendanceStatus === 'Regular').length,
          ];
        }),
      };
    }

    if (reportType === 'fee_recovery') {
      const feeMap = new Map(feeRecords.map((r) => [r.studentId, r]));
      return {
        headers: ['Student ID', 'Student Name', 'Centre', 'Status', 'Total Fee', 'Paid', 'Pending', 'Assigned'],
        rows: filteredStudents.map((s) => {
          const rec = feeMap.get(s.studentId);
          if (rec) {
            return [
              s.studentId,
              s.studentName,
              CENTRE_MAP[s.centreId].code,
              rec.recoveryStatus,
              rec.totalFee,
              rec.paidAmount,
              rec.pendingAmount,
              rec.assignedEmployeeName || s.assignedEmployeeName || 'Unassigned',
            ];
          }
          const extras = s.extraColumns || {};
          const findExtra = (rx: RegExp): string => {
            for (const [k, v] of Object.entries(extras)) {
              if (rx.test(k.toLowerCase())) return v;
            }
            return '';
          };
          const hasExtraFee =
            Boolean(findExtra(/total.*fee|course.*fee|package/)) ||
            Boolean(findExtra(/paid|jama|deposit|received/)) ||
            Boolean(findExtra(/pending|baki|baaki|due|balance/));
          const reconciled = hasExtraFee
            ? reconcileFeeNumbers({
                totalFeeRaw: findExtra(/total.*fee|course.*fee|package/),
                paidAmountRaw: findExtra(/paid|jama|deposit|received/),
                pendingAmountRaw: findExtra(/pending|baki|baaki|due|balance/),
                feeStatusRaw: findExtra(/fee.*status|payment.*status/),
              })
            : null;
          return [
            s.studentId,
            s.studentName,
            CENTRE_MAP[s.centreId].code,
            reconciled?.recoveryStatus || 'Pending',
            reconciled?.totalFee ?? 0,
            reconciled?.paidAmount ?? 0,
            reconciled?.pendingAmount ?? 0,
            s.assignedEmployeeName || 'Unassigned',
          ];
        }),
      };
    }

    if (reportType === 'practical') {
      const pMap = new Map(practicalRecords.map((r) => [r.studentId, r]));
      return {
        headers: ['Student ID', 'Student Name', 'Centre', 'Practical Status', 'Submission', 'Completion %', 'Assigned'],
        rows: filteredStudents.map((s) => {
          const rec = pMap.get(s.studentId);
          return [
            s.studentId,
            s.studentName,
            CENTRE_MAP[s.centreId].code,
            rec?.practicalStatus || s.practicalStatus,
            rec?.submissionStatus || 'Not Submitted',
            rec?.completionPercentage ?? (s.practicalStatus === 'Completed' ? 100 : 0),
            rec?.assignedEmployeeName || s.assignedEmployeeName || 'Unassigned',
          ];
        }),
      };
    }

    if (reportType === 'tma') {
      const tMap = new Map(tmaRecords.map((r) => [r.studentId, r]));
      return {
        headers: ['Student ID', 'Student Name', 'Centre', 'TMA Status', 'Submitted Files', 'Total Subjects', 'Assigned'],
        rows: filteredStudents.map((s) => {
          const rec = tMap.get(s.studentId);
          return [
            s.studentId,
            s.studentName,
            CENTRE_MAP[s.centreId].code,
            rec?.tmaStatus || s.tmaStatus,
            rec?.subjectsSubmittedCount ?? 0,
            rec?.totalSubjectsCount ?? 5,
            rec?.assignedEmployeeName || s.assignedEmployeeName || 'Unassigned',
          ];
        }),
      };
    }

    if (reportType === 'online_classes') {
      const oMap = new Map(onlineClassRecords.map((r) => [r.studentId, r]));
      return {
        headers: ['Student ID', 'Student Name', 'Centre', 'Attendance', 'Participation', 'Attendance %', 'Assigned'],
        rows: filteredStudents.map((s) => {
          const rec = oMap.get(s.studentId);
          return [
            s.studentId,
            s.studentName,
            CENTRE_MAP[s.centreId].code,
            rec?.attendanceStatus || s.classAttendanceStatus,
            rec?.participationLevel || 'Moderate',
            rec?.attendancePercentage ?? 75,
            rec?.assignedEmployeeName || s.assignedEmployeeName || 'Unassigned',
          ];
        }),
      };
    }

    if (reportType === 'admission') {
      const aMap = new Map(admissionRecords.map((r) => [r.studentId, r]));
      return {
        headers: ['Student ID', 'Student Name', 'Centre', 'Admission Status', 'Follow-Up', 'Admission Date', 'Assigned'],
        rows: filteredStudents.map((s) => {
          const rec = aMap.get(s.studentId);
          return [
            s.studentId,
            s.studentName,
            CENTRE_MAP[s.centreId].code,
            rec?.admissionStatus || 'Confirmed',
            rec?.followUpStatus || 'Completed',
            s.admissionDate,
            rec?.assignedEmployeeName || s.assignedEmployeeName || 'Unassigned',
          ];
        }),
      };
    }

    const staff = users
      .filter((u) => u.role === 'employee')
      .filter((u) => (effectiveCentre === 'all' ? true : u.centreId === effectiveCentre))
      .filter((u) => (deptFilter === 'all' ? true : u.department === deptFilter));

    return {
      headers: ['Employee Name', 'Email', 'Centre', 'Department', 'Status', 'Assigned Students'],
      rows: staff.map((emp) => [
        emp.fullName,
        emp.email,
        CENTRE_MAP[emp.centreId].code,
        DEPARTMENT_LABELS[emp.department],
        emp.status,
        filteredStudents.filter((s) => s.assignedEmployeeUid === emp.uid).length,
      ]),
    };
  }, [
    reportType,
    effectiveCentre,
    filteredStudents,
    feeRecords,
    practicalRecords,
    tmaRecords,
    onlineClassRecords,
    admissionRecords,
    users,
    deptFilter,
  ]);

  const handleExportCsv = () => {
    if (activeTab === 'work_reports') {
      const headers = ['Date', 'Employee', 'Email', 'Centre', 'Department', 'Title', 'Tasks', 'Students', 'Summary', 'Status', 'Reviewer Note'];
      const rows = filteredWorkReports.map((r) => [
        r.reportDate,
        r.employeeName,
        r.employeeEmail,
        r.centreName,
        DEPARTMENT_LABELS[r.department],
        r.title,
        r.tasksCompleted,
        r.studentsHandled,
        r.summary,
        r.status,
        r.reviewerNote || '',
      ]);
      exportToCsv(`staff-work-reports-${effectiveCentre}.csv`, headers, rows);
      onNotify('Work Reports Exported', `Downloaded ${rows.length} submitted employee reports.`, 'success');
      return;
    }
    exportToCsv(`database-security-${reportType}-${effectiveCentre}.csv`, reportPayload.headers, reportPayload.rows);
    onNotify('CSV Exported', `Downloaded ${reportPayload.rows.length} rows.`, 'success');
  };

  const handleExportExcel = () => {
    if (activeTab === 'work_reports') {
      const headers = ['Date', 'Employee', 'Email', 'Centre', 'Department', 'Title', 'Tasks', 'Students', 'Summary', 'Status', 'Reviewer Note'];
      const rows = filteredWorkReports.map((r) => [
        r.reportDate,
        r.employeeName,
        r.employeeEmail,
        r.centreName,
        DEPARTMENT_LABELS[r.department],
        r.title,
        r.tasksCompleted,
        r.studentsHandled,
        r.summary,
        r.status,
        r.reviewerNote || '',
      ]);
      exportToExcel(`staff-work-reports-${effectiveCentre}.xls`, 'work_reports', headers, rows);
      onNotify('Excel Exported', `Downloaded ${rows.length} work reports.`, 'success');
      return;
    }
    exportToExcel(
      `database-security-${reportType}-${effectiveCentre}.xls`,
      reportType,
      reportPayload.headers,
      reportPayload.rows,
    );
    onNotify('Excel Exported', `Downloaded ${reportPayload.rows.length} rows.`, 'success');
  };

  return (
    <div className="space-y-5">
      {/* Header + Mode Switch */}
      <div className="bg-white rounded-2xl border border-zinc-200 p-5 no-print shadow-xs">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <h2 className="text-lg font-extrabold text-black">Staff Reports &amp; Institutional Analytics</h2>
            <p className="text-xs text-zinc-700 mt-0.5">
              Employees can submit their daily department work reports directly; Centre Heads and Super Admin review &amp; export all reports.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2.5">
            <button
              type="button"
              onClick={handleExportCsv}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-black bg-white border border-zinc-300 rounded-lg hover:bg-zinc-100"
            >
              <Download className="w-3.5 h-3.5" />
              Export CSV
            </button>
            <button
              type="button"
              onClick={handleExportExcel}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-black bg-white border border-zinc-300 rounded-lg hover:bg-zinc-100"
            >
              <FileSpreadsheet className="w-3.5 h-3.5" />
              Export Excel
            </button>
            <button
              type="button"
              onClick={() => window.print()}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-bold text-white btn-crimson-gloss rounded-xl shadow-xs"
            >
              <Printer className="w-3.5 h-3.5" />
              Print Report
            </button>
          </div>
        </div>

        {/* Section Tabs */}
        <div className="mt-4 pt-4 border-t border-slate-200 flex flex-wrap items-center justify-between gap-3">
          <div className="inline-flex p-1 bg-slate-100 border border-slate-200 rounded-xl">
            <button
              type="button"
              onClick={() => setActiveTab('work_reports')}
              className={`inline-flex items-center gap-1.5 px-4 py-2 text-xs font-bold rounded-lg transition-colors ${
                activeTab === 'work_reports'
                  ? 'btn-crimson-gloss text-white shadow-xs'
                  : 'text-slate-700 hover:text-slate-900'
              }`}
            >
              <FileText className={`w-3.5 h-3.5 ${activeTab === 'work_reports' ? 'text-white' : 'text-[#DC2626]'}`} />
              Send &amp; View Employee Reports ({filteredWorkReports.length})
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('analytics')}
              className={`inline-flex items-center gap-1.5 px-4 py-2 text-xs font-bold rounded-lg transition-colors ${
                activeTab === 'analytics'
                  ? 'btn-crimson-gloss text-white shadow-xs'
                  : 'text-slate-700 hover:text-slate-900'
              }`}
            >
              <BarChart3 className={`w-3.5 h-3.5 ${activeTab === 'analytics' ? 'text-white' : 'text-[#DC2626]'}`} />
              Database Analytics Tables
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            {currentUser.role === 'super_admin' && (
              <select
                value={centreFilter}
                onChange={(e) => setCentreFilter(e.target.value as CentreId | 'all')}
                className="px-3 py-1.5 text-xs border border-zinc-300 rounded-lg bg-white text-black font-medium focus:outline-none focus:ring-2 focus:ring-black"
              >
                <option value="all">All 4 Centres</option>
                {CANONICAL_CENTRES.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            )}
            {currentUser.role !== 'employee' && (
              <select
                value={deptFilter}
                onChange={(e) => setDeptFilter(e.target.value as UserDepartment)}
                className="px-3 py-1.5 text-xs border border-zinc-300 rounded-lg bg-white text-black font-medium focus:outline-none focus:ring-2 focus:ring-black"
              >
                <option value="all">All Departments</option>
                {DEPARTMENTS.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.label}
                  </option>
                ))}
              </select>
            )}
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-zinc-600 absolute left-2.5 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search reports..."
                className="pl-8 pr-3 py-1.5 text-xs bg-white text-black placeholder:text-zinc-500 border border-zinc-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-black"
              />
            </div>
          </div>
        </div>
      </div>

      {activeTab === 'work_reports' ? (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
          {/* Submit Daily / Department Report Card (Available to ALL Employees, Centre Heads, Super Admin) */}
          <div className="lg:col-span-5 bg-white rounded-2xl border border-zinc-200 p-5 sm:p-6 shadow-xs no-print h-fit">
            <div className="pb-3 border-b border-zinc-200">
              <p className="text-[11px] font-bold uppercase tracking-wider text-[#B45309]">
                {CENTRE_MAP[currentUser.centreId].name} · {DEPARTMENT_LABELS[currentUser.department]}
              </p>
              <h3 className="text-base font-extrabold text-black mt-0.5">Send Work / Department Report</h3>
              <p className="text-xs text-zinc-700 mt-0.5">
                Submit your daily activity summary, student count handled, and pending escalations.
              </p>
            </div>

            <form onSubmit={handleSubmitWorkReport} className="mt-4 space-y-3.5">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-black mb-1">Report Date</label>
                  <input
                    type="date"
                    required
                    value={reportDate}
                    onChange={(e) => setReportDate(e.target.value)}
                    className="w-full px-3 py-2 text-xs font-mono bg-white text-black border border-zinc-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-black"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-black mb-1">Tasks Completed</label>
                  <input
                    type="number"
                    min={0}
                    max={10000}
                    required
                    value={tasksCompleted}
                    onChange={(e) => setTasksCompleted(e.target.value)}
                    className="w-full px-3 py-2 text-xs font-mono bg-white text-black border border-zinc-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-black"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-black mb-1">Students Handled</label>
                  <input
                    type="number"
                    min={0}
                    max={10000}
                    required
                    value={studentsHandled}
                    onChange={(e) => setStudentsHandled(e.target.value)}
                    className="w-full px-3 py-2 text-xs font-mono bg-white text-black border border-zinc-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-black"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-black mb-1">Report Subject / Title</label>
                <input
                  type="text"
                  required
                  value={reportTitle}
                  onChange={(e) => setReportTitle(e.target.value)}
                  placeholder="e.g. Daily Fee Follow-up & Collection Summary"
                  className="w-full px-3 py-2 text-sm bg-white text-black placeholder:text-zinc-500 border border-zinc-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-black"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-black mb-1">Detailed Work Summary</label>
                <textarea
                  rows={4}
                  required
                  value={reportSummary}
                  onChange={(e) => setReportSummary(e.target.value)}
                  placeholder="Describe calls made, admissions processed, TMA/practical updates, or collections..."
                  className="w-full px-3 py-2 text-sm bg-white text-black placeholder:text-zinc-500 border border-zinc-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-black"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-black mb-1">
                  Pending Issues / Escalations (Optional)
                </label>
                <textarea
                  rows={2}
                  value={pendingIssues}
                  onChange={(e) => setPendingIssues(e.target.value)}
                  placeholder="Any blockers or student issues requiring Centre Head / Super Admin attention..."
                  className="w-full px-3 py-2 text-sm bg-white text-black placeholder:text-zinc-500 border border-zinc-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-black"
                />
              </div>

              <button
                type="submit"
                disabled={submittingReport}
                className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 text-xs font-bold text-white btn-crimson-gloss rounded-xl transition-all disabled:opacity-50"
              >
                <Send className="w-3.5 h-3.5" />
                {submittingReport ? 'Sending Report...' : 'Submit Report to Leadership'}
              </button>
            </form>
          </div>

          {/* Submitted Reports Inbox */}
          <div className="lg:col-span-7 bg-white rounded-2xl border border-zinc-200 overflow-hidden shadow-xs">
            <div className="px-5 py-4 border-b border-zinc-200 flex items-center justify-between">
              <div>
                <h3 className="text-sm font-bold text-black">
                  {currentUser.role === 'employee' ? 'My Submitted Work Reports' : 'Employee Reports Inbox'}
                </h3>
                <p className="text-xs text-zinc-700 mt-0.5">
                  {effectiveCentre === 'all' ? 'All 4 Centres' : CENTRE_MAP[effectiveCentre]?.name}
                </p>
              </div>
              <span className="text-xs font-mono font-bold text-black">{filteredWorkReports.length} reports</span>
            </div>

            {filteredWorkReports.length === 0 ? (
              <div className="p-10 text-center text-xs text-zinc-700">
                <FileText className="w-8 h-8 text-zinc-400 mx-auto mb-2" />
                No staff work reports submitted yet. Employees can use the form to send their reports.
              </div>
            ) : (
              <div className="divide-y divide-zinc-200">
                {filteredWorkReports.map((rep) => (
                  <div key={rep.reportId} className="p-5 hover:bg-zinc-50 transition-colors">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <div className="flex flex-wrap items-center gap-2 text-[11px]">
                          <span className="font-mono font-bold text-[#B45309]">{rep.reportDate}</span>
                          <span className="text-zinc-400">·</span>
                          <span className="font-semibold text-black">{rep.centreName}</span>
                          <span className="text-zinc-400">·</span>
                          <span className="font-semibold text-zinc-700">{DEPARTMENT_LABELS[rep.department]}</span>
                        </div>
                        <h4 className="text-sm font-bold text-black mt-1">{rep.title}</h4>
                        <p className="text-xs text-zinc-700 mt-0.5">
                          Submitted by <strong className="text-black">{rep.employeeName}</strong> ({rep.employeeEmail})
                        </p>
                      </div>

                      <span
                        className={`px-2.5 py-1 rounded-md text-[11px] font-bold ${
                          rep.status === 'Approved'
                            ? 'bg-emerald-50 text-emerald-800 border border-emerald-200'
                            : rep.status === 'Reviewed'
                              ? 'bg-zinc-100 text-black border border-zinc-300'
                              : 'bg-amber-50 text-amber-900 border border-amber-300'
                        }`}
                      >
                        {rep.status}
                      </span>
                    </div>

                    <p className="mt-3 text-xs text-zinc-800 leading-relaxed whitespace-pre-line">{rep.summary}</p>

                    <div className="mt-3 flex flex-wrap items-center gap-4 text-[11px] text-zinc-700 font-mono">
                      <span>Tasks: <strong className="text-black">{rep.tasksCompleted}</strong></span>
                      <span>Students Handled: <strong className="text-black">{rep.studentsHandled}</strong></span>
                      <span className="text-zinc-600">{formatDateTime(rep.createdAt)}</span>
                    </div>

                    {rep.pendingIssues && (
                      <p className="mt-2 text-xs text-black bg-amber-50 border border-amber-300 rounded-lg px-3 py-2">
                        <strong>Pending / Escalation:</strong> {rep.pendingIssues}
                      </p>
                    )}

                    {rep.reviewerNote && (
                      <p className="mt-2 text-xs text-emerald-950 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">
                        <strong>Review Note ({rep.reviewerName}):</strong> {rep.reviewerNote}
                      </p>
                    )}

                    {(currentUser.role === 'super_admin' || currentUser.role === 'centre_head') && (
                      <div className="mt-3 pt-3 border-t border-zinc-200 flex justify-end no-print">
                        <button
                          type="button"
                          onClick={() => {
                            setReviewingReport(rep);
                            setReviewStatus(rep.status === 'Submitted' ? 'Approved' : rep.status);
                            setReviewNote(rep.reviewerNote || '');
                          }}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-black bg-zinc-100 hover:bg-zinc-200 rounded-lg"
                        >
                          <CheckCircle2 className="w-3.5 h-3.5" />
                          Review / Approve
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      ) : (
        <>
          {/* Mathematical Fee & Department Analytics Graphs */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <div className="bg-white rounded-xl border border-zinc-200 p-4">
              <p className="text-[11px] font-bold uppercase tracking-wider text-zinc-600">Scoped Students</p>
              <p className="text-2xl font-extrabold font-mono text-black tabular-nums mt-1">
                {analytics.totalStudents}
              </p>
            </div>
            <div className="bg-white rounded-xl border border-zinc-200 p-4">
              <p className="text-[11px] font-bold uppercase tracking-wider text-zinc-600">Total Fee Billed</p>
              <p className="text-2xl font-extrabold font-mono text-black tabular-nums mt-1">
                ₹{analytics.totalFeeBilled.toLocaleString('en-IN')}
              </p>
            </div>
            <div className="bg-white rounded-xl border border-emerald-200 p-4">
              <p className="text-[11px] font-bold uppercase tracking-wider text-emerald-700">
                Collected ({analytics.collectionRatePct}%)
              </p>
              <p className="text-2xl font-extrabold font-mono text-emerald-700 tabular-nums mt-1">
                ₹{analytics.totalFeePaid.toLocaleString('en-IN')}
              </p>
            </div>
            <div className="bg-white rounded-xl border border-rose-200 p-4">
              <p className="text-[11px] font-bold uppercase tracking-wider text-red-700">Pending Recovery</p>
              <p className="text-2xl font-extrabold font-mono text-red-700 tabular-nums mt-1">
                ₹{analytics.totalFeePending.toLocaleString('en-IN')}
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="bg-white rounded-xl border border-zinc-200 p-4">
              <h3 className="text-sm font-bold text-black">Branch Fee Graph (Paid vs. Pending)</h3>
              <p className="text-xs text-zinc-600 mb-3">Accurate financial breakdown computed from uploaded records</p>
              <div className="h-52 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={analytics.branchMetrics} margin={{ top: 6, right: 10, left: 6, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
                    <XAxis dataKey="name" tick={{ fontSize: 11, fill: '#1E293B' }} />
                    <YAxis
                      tick={{ fontSize: 11, fill: '#1E293B' }}
                      tickFormatter={(v) => `₹${Number(v) >= 1000 ? `${Math.round(Number(v) / 1000)}k` : v}`}
                    />
                    <Tooltip formatter={(val: unknown) => `₹${Number(val || 0).toLocaleString('en-IN')}`} />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                    <Bar dataKey="paidFee" name="Paid (Jama)" fill="#059669" radius={[4, 4, 0, 0]} />
                    <Bar dataKey="pendingFee" name="Pending (Baki)" fill="#DC2626" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div className="bg-white rounded-xl border border-zinc-200 p-4">
              <h3 className="text-sm font-bold text-black">Department Completion Rate (%)</h3>
              <p className="text-xs text-zinc-600 mb-3">Percentage of students completed across all 5 departments</p>
              <div className="h-52 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={analytics.departmentPerformance} margin={{ top: 6, right: 10, left: -10, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
                    <XAxis dataKey="department" tick={{ fontSize: 11, fill: '#1E293B' }} />
                    <YAxis domain={[0, 100]} tick={{ fontSize: 11, fill: '#1E293B' }} tickFormatter={(v) => `${v}%`} />
                    <Tooltip formatter={(val: unknown) => `${val}%`} />
                    <Bar dataKey="completionPct" name="Completion %" fill="#2563EB" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>

          {/* Operational Report Selector */}
          <div className="bg-white rounded-xl border border-zinc-200 p-4 grid grid-cols-1 sm:grid-cols-3 gap-3 no-print">
            <select
              value={reportType}
              onChange={(e) => setReportType(e.target.value as ReportType)}
              className="px-3 py-2 text-sm border border-zinc-300 rounded-lg bg-white text-black font-medium focus:outline-none focus:ring-2 focus:ring-black"
            >
              {allowedReports.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label}
                </option>
              ))}
            </select>

            <input
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              aria-label="From date"
              className="px-3 py-2 text-sm font-mono bg-white text-black border border-zinc-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-black"
            />

            <input
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              aria-label="To date"
              className="px-3 py-2 text-sm font-mono bg-white text-black border border-zinc-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-black"
            />
          </div>

          <div className="bg-white rounded-xl border border-zinc-200 overflow-hidden shadow-xs">
            <div className="px-5 py-4 border-b border-zinc-200 flex items-center justify-between">
              <div>
                <h3 className="text-sm font-bold text-black">
                  DATABASE SECURITY — {allowedReports.find((r) => r.id === reportType)?.label}
                </h3>
                <p className="text-xs text-zinc-700 mt-0.5">
                  Scope: {effectiveCentre === 'all' ? 'All Centres' : CENTRE_MAP[effectiveCentre]?.name} · Generated by{' '}
                  {currentUser.fullName}
                </p>
              </div>
              <span className="text-xs font-mono font-bold text-black">{reportPayload.rows.length} rows</span>
            </div>

            {reportPayload.rows.length === 0 ? (
              <div className="p-10 text-center text-xs text-zinc-700">
                <BarChart3 className="w-8 h-8 text-zinc-400 mx-auto mb-2" />
                No records match the selected report parameters.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="bg-zinc-50 border-b border-zinc-200 text-[11px] font-bold text-zinc-700 uppercase tracking-wider">
                      {reportPayload.headers.map((h) => (
                        <th key={h} className="py-3 px-4">
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-200 text-xs">
                    {reportPayload.rows.map((row, idx) => (
                      <tr key={idx} className="hover:bg-zinc-50">
                        {row.map((cell, cIdx) => (
                          <td
                            key={cIdx}
                            className={`py-3 px-4 ${typeof cell === 'number' ? 'font-mono tabular-nums font-bold text-black' : 'text-zinc-800'}`}
                          >
                            {cell}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}

      {/* Review Employee Report Modal */}
      {reviewingReport && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#040E24]/75 backdrop-blur-md p-4">
          <div className="glass-light-card rounded-2xl border border-slate-200 shadow-2xl max-w-md w-full p-6 text-slate-900">
            <div className="flex items-start justify-between pb-3 border-b border-zinc-200">
              <div>
                <h3 className="text-base font-bold text-black">Review Staff Work Report</h3>
                <p className="text-xs text-zinc-700 mt-0.5">
                  {reviewingReport.employeeName} · {reviewingReport.centreName}
                </p>
              </div>
              <button type="button" onClick={() => setReviewingReport(null)} className="text-zinc-600 hover:text-black">
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleSaveReview} className="mt-4 space-y-3.5">
              <div>
                <label className="block text-xs font-semibold text-black mb-1">Status</label>
                <select
                  value={reviewStatus}
                  onChange={(e) => setReviewStatus(e.target.value as EmployeeReportStatus)}
                  className="w-full px-3 py-2 text-sm bg-white text-black border border-zinc-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-black"
                >
                  <option value="Reviewed">Reviewed</option>
                  <option value="Approved">Approved</option>
                  <option value="Submitted">Submitted</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-semibold text-black mb-1">Feedback / Remarks</label>
                <textarea
                  rows={3}
                  value={reviewNote}
                  onChange={(e) => setReviewNote(e.target.value)}
                  placeholder="Optional acknowledgement or instructions for the employee..."
                  className="w-full px-3 py-2 text-sm bg-white text-black placeholder:text-zinc-500 border border-zinc-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-black"
                />
              </div>
              <div className="flex justify-end gap-2.5 pt-2">
                <button
                  type="button"
                  onClick={() => setReviewingReport(null)}
                  className="px-4 py-2 text-xs font-semibold text-black bg-white hover:bg-zinc-100 border border-zinc-300 rounded-lg"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={savingReview}
                  className="px-4 py-2 text-xs font-bold text-white btn-crimson-gloss rounded-lg disabled:opacity-50"
                >
                  {savingReview ? 'Saving...' : 'Save Review'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
