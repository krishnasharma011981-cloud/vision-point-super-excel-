import {
  CalendarClock,
  CheckCircle2,
  ClipboardList,
  Clock,
  Eye,
  MessageCircle,
  Phone,
  Plus,
  RefreshCw,
  Save,
  Trash2,
  User,
  X,
} from 'lucide-react';
import React, { useEffect, useMemo, useState } from 'react';
import { CENTRE_MAP } from '../constants/centres';
import {
  buildQuickFollowUpPreset,
  buildTaskCallLink,
  buildTaskWhatsAppLink,
  computeAssignmentProgress,
  formatFollowUpSchedule,
  WORK_ASSIGNMENT_DEPARTMENT_LABELS,
  type QuickFollowUpPreset,
} from '../lib/workAssignment';
import {
  deleteWorkAssignmentBatch,
  updateWorkAssignmentStatus,
  updateWorkAssignmentTask,
} from '../services/firestoreService';
import type {
  CallTaskStatus,
  CentreId,
  UserAccount,
  WorkAssignment,
  WorkAssignmentDepartment,
  WorkAssignmentTask,
} from '../types/domain';

interface StaffWorkCallingWorkspaceProps {
  department: WorkAssignmentDepartment;
  currentUser: UserAccount;
  assignments: WorkAssignment[];
  tasks: WorkAssignmentTask[];
  onNotify: (title: string, description: string, variant: 'success' | 'error' | 'warning' | 'info') => void;
}

const CALL_STATUS_OPTIONS: Array<{ value: CallTaskStatus; label: string; activeClass: string }> = [
  {
    value: 'Pending',
    label: 'Pending',
    activeClass: 'bg-slate-900 text-white border-slate-900',
  },
  {
    value: 'Follow-up Scheduled',
    label: 'Follow-up Set',
    activeClass: 'bg-amber-600 text-white border-amber-600',
  },
  {
    value: 'Not Answered',
    label: 'No Answer / Busy',
    activeClass: 'bg-rose-700 text-white border-rose-700',
  },
  {
    value: 'Called - Done',
    label: 'Completed / Done',
    activeClass: 'bg-emerald-700 text-white border-emerald-700',
  },
];

const QUICK_PRESETS: Array<{ id: QuickFollowUpPreset; label: string }> = [
  { id: 'tomorrow_4pm', label: 'Kal 4:00 PM' },
  { id: 'tomorrow_11am', label: 'Kal 11:00 AM' },
  { id: 'today_plus_2h', label: 'Aaj +2 Ghante' },
  { id: 'day_after_11am', label: 'Parso 11:00 AM' },
];

export const StaffWorkCallingWorkspace: React.FC<StaffWorkCallingWorkspaceProps> = ({
  department,
  currentUser,
  assignments,
  tasks,
  onNotify,
}) => {
  const activeBatches = useMemo(
    () =>
      assignments
        .filter(
          (a) =>
            a.staffUid === currentUser.uid &&
            a.department === department &&
            a.status === 'Active',
        )
        .sort((a, b) => b.assignedDate.localeCompare(a.assignedDate)),
    [assignments, currentUser.uid, department],
  );

  const [selectedBatchId, setSelectedBatchId] = useState<string>('');
  const [filterTab, setFilterTab] = useState<'all' | 'pending' | 'followup' | 'done'>('all');
  const [selectedTaskId, setSelectedTaskId] = useState<string>('');

  // Editable form state for the active student box
  const [callStatus, setCallStatus] = useState<CallTaskStatus>('Pending');
  const [followUpDate, setFollowUpDate] = useState('');
  const [followUpTime, setFollowUpTime] = useState('');
  const [remark, setRemark] = useState('');
  const [validationError, setValidationError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Auto-select latest active batch whenever activeBatches changes (e.g., when Centre Head re-assigns new work)
  useEffect(() => {
    if (activeBatches.length === 0) {
      setSelectedBatchId('');
      return;
    }
    if (!activeBatches.some((b) => b.assignmentId === selectedBatchId)) {
      setSelectedBatchId(activeBatches[0].assignmentId);
    }
  }, [activeBatches, selectedBatchId]);

  const currentBatch = activeBatches.find((b) => b.assignmentId === selectedBatchId) || activeBatches[0] || null;

  const batchTasks = useMemo(() => {
    if (!currentBatch) return [];
    return tasks
      .filter((t) => t.assignmentId === currentBatch.assignmentId)
      .sort((a, b) => (a.serialNumber || 0) - (b.serialNumber || 0));
  }, [tasks, currentBatch]);

  const progress = useMemo(() => computeAssignmentProgress(batchTasks), [batchTasks]);

  const filteredTasks = useMemo(() => {
    return batchTasks.filter((t) => {
      if (filterTab === 'pending' && t.callStatus !== 'Pending' && t.callStatus !== 'Not Answered') {
        return false;
      }
      if (filterTab === 'followup' && t.callStatus !== 'Follow-up Scheduled') {
        return false;
      }
      if (filterTab === 'done' && t.callStatus !== 'Called - Done') {
        return false;
      }
      return true;
    });
  }, [batchTasks, filterTab]);

  // Keep selectedTaskId synced with available tasks (auto-resume on first Pending student)
  useEffect(() => {
    if (filteredTasks.length === 0) {
      setSelectedTaskId('');
      return;
    }
    if (!filteredTasks.some((t) => t.taskId === selectedTaskId)) {
      const firstUnworked =
        filterTab === 'all' ? filteredTasks.find((t) => t.callStatus === 'Pending') : null;
      setSelectedTaskId((firstUnworked || filteredTasks[0]).taskId);
    }
  }, [filteredTasks, selectedTaskId, filterTab]);

  const activeTask = useMemo(
    () => filteredTasks.find((t) => t.taskId === selectedTaskId) || filteredTasks[0] || null,
    [filteredTasks, selectedTaskId],
  );

  const activeIndex = activeTask ? filteredTasks.findIndex((t) => t.taskId === activeTask.taskId) : -1;

  // Populate editor fields whenever switching student
  useEffect(() => {
    if (!activeTask) return;
    setCallStatus(activeTask.callStatus || 'Pending');
    setFollowUpDate(activeTask.followUpDate || '');
    setFollowUpTime(activeTask.followUpTime || '');
    setRemark(activeTask.remark || '');
    setValidationError(null);
  }, [activeTask?.taskId, activeTask?.callStatus, activeTask?.followUpDate, activeTask?.followUpTime, activeTask?.remark]);

  const deptLabel = WORK_ASSIGNMENT_DEPARTMENT_LABELS[department];

  const handleApplyPreset = (preset: QuickFollowUpPreset) => {
    const { date, time } = buildQuickFollowUpPreset(preset);
    setFollowUpDate(date);
    setFollowUpTime(time);
    if (callStatus === 'Pending' || callStatus === 'Not Answered') {
      setCallStatus('Follow-up Scheduled');
    }
  };

  const handleSaveTask = async (advanceNext: boolean) => {
    if (!activeTask) return;

    const trimmedRemark = remark.trim();
    if (!trimmedRemark) {
      const msg =
        'Pehle call karke Call Remark likhein (student/parent ne kya bola), tabhi details save hokar agla student khulega.';
      setValidationError(msg);
      onNotify('Call Details Required', msg, 'warning');
      return;
    }

    setValidationError(null);
    setSaving(true);
    try {
      const nextStatus: CallTaskStatus =
        callStatus === 'Pending'
          ? followUpDate
            ? 'Follow-up Scheduled'
            : 'Called - Done'
          : callStatus;

      await updateWorkAssignmentTask(
        activeTask,
        {
          callStatus: nextStatus,
          followUpDate,
          followUpTime,
          remark: trimmedRemark,
          markCalledNow: true,
        },
        currentUser,
      );

      onNotify(
        'Call Update Saved',
        `Saved remark & follow-up for #${activeTask.serialNumber} ${activeTask.studentName}. Synced to department sheet.`,
        'success',
      );

      if (advanceNext && activeIndex >= 0 && activeIndex < filteredTasks.length - 1) {
        setSelectedTaskId(filteredTasks[activeIndex + 1].taskId);
      }
    } catch (err) {
      onNotify(
        'Save Failed',
        err instanceof Error ? err.message : 'Unable to save calling update.',
        'error',
      );
    } finally {
      setSaving(false);
    }
  };

  if (!currentBatch) {
    return (
      <div className="bg-white rounded-2xl border border-slate-200 p-10 text-center max-w-2xl mx-auto">
        <div className="w-14 h-14 rounded-2xl bg-slate-100 border border-slate-200 flex items-center justify-center mx-auto mb-4 text-slate-600">
          <ClipboardList className="w-7 h-7" />
        </div>
        <h2 className="text-xl font-bold text-slate-950">No Active {deptLabel} Batch Assigned Yet</h2>
        <p className="text-sm text-slate-600 mt-2 leading-relaxed max-w-lg mx-auto">
          Abhi aapko koi calling batch assign nahi hua hai. Jaise hi aapke <strong>Centre Head</strong> ya <strong>Super Admin</strong> aapko student serial range (jaise 1 se 50) assign karenge, aapka calling box yahaan turant dikhne lagega.
        </p>
        <p className="text-xs font-mono text-slate-500 mt-4">
          Branch: {CENTRE_MAP[currentUser.centreId]?.name || currentUser.centreName} · Staff: {currentUser.fullName}
        </p>
      </div>
    );
  }

  const schedulePreview = formatFollowUpSchedule(followUpDate, followUpTime);
  const telHref = activeTask ? buildTaskCallLink(activeTask) : null;
  const waHref = activeTask ? buildTaskWhatsAppLink(activeTask) : null;
  const displayPhone = activeTask?.callingNumber || activeTask?.mobileNumber || 'Not Provided';

  return (
    <div className="w-full space-y-4">
      {/* Top Assigned Batch Header — Horizontal Strip on Desktop, Vertical Stack on Mobile */}
      <div className="bg-white rounded-2xl border border-slate-200 p-4 sm:p-5 space-y-3.5">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div className="min-w-0">
            <p className="text-[11px] font-bold uppercase tracking-wider text-red-700">
              {deptLabel} · Assigned Work Box
            </p>
            <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5 mt-0.5">
              <h2 className="text-lg sm:text-xl font-extrabold text-slate-950">
                S.No #{currentBatch.fromSerial} to #{currentBatch.toSerial}
              </h2>
              <span className="text-slate-500 font-mono font-semibold text-sm tabular-nums">
                ({progress.total} Students)
              </span>
            </div>
            <p className="text-xs text-slate-600 mt-1">
              Assigned by <strong className="text-slate-900">{currentBatch.assignedByName}</strong> on{' '}
              <span className="font-mono">{currentBatch.assignedDate}</span>
              {currentBatch.note ? ` · Note: ${currentBatch.note}` : ''}
            </p>
          </div>

          {/* Live Progress Counters — Horizontal Metric Row */}
          <div className="grid grid-cols-4 gap-2 sm:gap-2.5 text-center shrink-0">
            <div className="px-2.5 sm:px-3.5 py-2 rounded-xl bg-slate-50 border border-slate-200">
              <p className="text-[10px] font-bold uppercase text-slate-600">Pending</p>
              <p className="text-base sm:text-lg font-extrabold font-mono tabular-nums text-slate-900">
                {progress.pending + progress.notAnswered}
              </p>
            </div>
            <div className="px-2.5 sm:px-3.5 py-2 rounded-xl bg-amber-50 border border-amber-200">
              <p className="text-[10px] font-bold uppercase text-amber-800">Follow-up</p>
              <p className="text-base sm:text-lg font-extrabold font-mono tabular-nums text-amber-900">
                {progress.followUpScheduled}
              </p>
            </div>
            <div className="px-2.5 sm:px-3.5 py-2 rounded-xl bg-emerald-50 border border-emerald-200">
              <p className="text-[10px] font-bold uppercase text-emerald-800">Done</p>
              <p className="text-base sm:text-lg font-extrabold font-mono tabular-nums text-emerald-800">
                {progress.completed}
              </p>
            </div>
            <div className="px-2.5 sm:px-3.5 py-2 rounded-xl bg-slate-900 text-white">
              <p className="text-[10px] font-bold uppercase text-slate-300">Progress</p>
              <p className="text-base sm:text-lg font-extrabold font-mono tabular-nums">{progress.percentDone}%</p>
            </div>
          </div>
        </div>

        {/* Filter Mode Controls (strictly 1 student visible at a time) */}
        <div className="pt-3 border-t border-slate-100 flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            {(
              [
                { id: 'all', label: `All (${batchTasks.length})` },
                { id: 'pending', label: `Pending (${progress.pending + progress.notAnswered})` },
                { id: 'followup', label: `Follow-up (${progress.followUpScheduled})` },
                { id: 'done', label: `Done (${progress.completed})` },
              ] as const
            ).map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setFilterTab(tab.id)}
                className={`px-3 py-1.5 rounded-lg font-bold border transition-colors whitespace-nowrap shrink-0 ${
                  filterTab === tab.id
                    ? 'bg-slate-900 text-white border-slate-900'
                    : 'bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {activeBatches.length > 1 && (
            <div className="flex flex-wrap items-center gap-1.5">
              {activeBatches.map((b) => (
                <button
                  key={b.assignmentId}
                  type="button"
                  onClick={() => setSelectedBatchId(b.assignmentId)}
                  className={`px-2.5 py-1 rounded-lg text-[11px] font-bold border transition-colors whitespace-nowrap shrink-0 ${
                    b.assignmentId === currentBatch.assignmentId
                      ? 'bg-red-700 text-white border-red-700'
                      : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
                  }`}
                >
                  #{b.fromSerial}–#{b.toSerial}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* SINGLE FOCUSED STUDENT CALLING BOX — Horizontal 2-Column Workspace on Desktop, Vertical Stack on Mobile */}
      <div>
        {!activeTask ? (
          <div className="bg-white rounded-2xl border border-slate-200 p-10 text-center space-y-2">
            <p className="text-base font-bold text-slate-900">No students in this filter</p>
            <p className="text-xs text-slate-600">
              Switch to <strong>All ({batchTasks.length})</strong> above to view assigned students.
            </p>
          </div>
        ) : (
          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5 sm:p-6 space-y-5">
            {/* Top Card Header — Strictly Sequential (No Previous/Next Skip) */}
            <div className="flex flex-wrap items-center justify-between gap-3 pb-4 border-b border-slate-200">
              <div className="flex items-center gap-3">
                <span className="px-3 py-1 rounded-lg bg-slate-900 text-white font-mono text-sm font-extrabold tabular-nums">
                  S.No #{activeTask.serialNumber}
                </span>
                <span className="text-xs font-mono font-semibold text-slate-600 tabular-nums">
                  Student {activeIndex + 1} of {filteredTasks.length}
                </span>
              </div>
              <p className="text-xs font-semibold text-slate-600">
                Call &amp; save details below to move to the next student
              </p>
            </div>

            {/* Responsive Horizontal Split on Desktop (lg:grid-cols-12) | Vertical Stack on Mobile (grid-cols-1) */}
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-stretch">
              {/* LEFT PANEL (Desktop): Student Identity, Father's Name, Fee/Subjects, Call & WhatsApp */}
              <div className="lg:col-span-5 flex flex-col justify-between gap-5 lg:border-r lg:border-slate-200 lg:pr-6">
                <div className="space-y-4">
                  <div>
                    <p className="text-xs font-bold uppercase tracking-wider text-slate-500">Student Name</p>
                    <h3 className="text-2xl xl:text-3xl font-extrabold text-slate-950 tracking-tight mt-0.5 break-words">
                      {activeTask.studentName}
                    </h3>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-1 gap-3">
                    <div className="p-4 rounded-xl bg-slate-50 border border-slate-200">
                      <p className="text-[11px] font-bold uppercase tracking-wider text-slate-500 flex items-center gap-1.5">
                        <User className="w-3.5 h-3.5 text-slate-600" />
                        Father&apos;s Name (Papa ka Naam)
                      </p>
                      <p className="text-base font-bold text-slate-900 mt-1 break-words">
                        {activeTask.fatherName || 'Not available in sheet'}
                      </p>
                    </div>

                    {department === 'fee_recovery' ? (
                      <div className="p-4 rounded-xl bg-red-50/70 border border-red-200">
                        <p className="text-[11px] font-bold uppercase tracking-wider text-red-800">
                          Fee Balance / Pending
                        </p>
                        <p className="text-xl font-extrabold font-mono tabular-nums text-red-700 mt-0.5">
                          ₹{activeTask.pendingFee.toLocaleString('en-IN')}
                          <span className="text-xs font-semibold text-slate-600 ml-2">
                            / Total ₹{activeTask.totalFee.toLocaleString('en-IN')}
                          </span>
                        </p>
                      </div>
                    ) : (
                      <div className="p-4 rounded-xl bg-slate-50 border border-slate-200">
                        <p className="text-[11px] font-bold uppercase tracking-wider text-slate-500">
                          {department === 'practical' ? 'Practical Subjects' : 'TMA Subjects'}
                        </p>
                        <p className="text-sm font-bold text-slate-900 mt-1 leading-snug break-words">
                          {activeTask.subject || 'Subjects not uploaded yet'}
                        </p>
                      </div>
                    )}
                  </div>
                </div>

                {/* Direct CALL & WHATSAPP Action Box */}
                <div className="p-4 rounded-xl bg-slate-50 border border-slate-200 space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-bold uppercase tracking-wider text-slate-600">
                      Contact Number
                    </span>
                    <span className="font-mono text-base font-extrabold tabular-nums text-slate-950 tracking-wide">
                      {displayPhone}
                    </span>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                    {telHref ? (
                      <a
                        href={telHref}
                        className="flex items-center justify-center gap-2 py-3.5 px-4 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-extrabold shadow-sm transition-colors whitespace-nowrap"
                      >
                        <Phone className="w-4 h-4 shrink-0" />
                        Call Now
                      </a>
                    ) : (
                      <div className="flex items-center justify-center gap-2 py-3.5 px-4 rounded-xl bg-slate-200 text-slate-500 text-sm font-bold whitespace-nowrap">
                        <Phone className="w-4 h-4 shrink-0" />
                        Phone Missing
                      </div>
                    )}

                    {waHref ? (
                      <a
                        href={waHref}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center justify-center gap-2 py-3.5 px-4 rounded-xl bg-[#16A34A] hover:bg-[#15803D] text-white text-sm font-extrabold shadow-sm transition-colors whitespace-nowrap"
                      >
                        <MessageCircle className="w-4 h-4 shrink-0" />
                        WhatsApp
                      </a>
                    ) : (
                      <div className="flex items-center justify-center gap-2 py-3.5 px-4 rounded-xl bg-slate-200 text-slate-500 text-sm font-bold whitespace-nowrap">
                        <MessageCircle className="w-4 h-4 shrink-0" />
                        No WhatsApp
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* RIGHT PANEL (Desktop): Follow-Up Date/Time, Call Remark, Call Status & Save Actions */}
              <div className="lg:col-span-7 flex flex-col justify-between gap-4">
                {/* Next Follow-up Date & Time Setting System */}
                <div className="p-4 sm:p-5 rounded-xl bg-amber-50/60 border border-amber-200 space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <CalendarClock className="w-4 h-4 text-amber-800 shrink-0" />
                      <h4 className="text-sm font-extrabold text-slate-950">
                        Next Follow-Up Date &amp; Time (Dubara Kab Phone Karna Hai)
                      </h4>
                    </div>
                    {(followUpDate || followUpTime) && (
                      <button
                        type="button"
                        onClick={() => {
                          setFollowUpDate('');
                          setFollowUpTime('');
                        }}
                        className="text-[11px] font-bold text-slate-600 hover:text-red-700 underline whitespace-nowrap"
                      >
                        Clear Schedule
                      </button>
                    )}
                  </div>

                  {/* 1-Click Quick Time Presets (e.g. Kal 4:00 PM) */}
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[11px] font-semibold text-slate-700">Quick Set:</span>
                    {QUICK_PRESETS.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => handleApplyPreset(p.id)}
                        className="px-3 py-1.5 text-xs font-bold text-amber-950 bg-white hover:bg-amber-100 border border-amber-300 rounded-lg transition-colors whitespace-nowrap"
                      >
                        {p.label}
                      </button>
                    ))}
                  </div>

                  {/* Custom Date + Time Inputs */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label htmlFor="staff-followup-date" className="block text-xs font-bold text-slate-800 mb-1">
                        Follow-Up Date (Tarikh)
                      </label>
                      <input
                        id="staff-followup-date"
                        type="date"
                        value={followUpDate}
                        onChange={(e) => {
                          setFollowUpDate(e.target.value);
                          if (e.target.value && (callStatus === 'Pending' || callStatus === 'Not Answered')) {
                            setCallStatus('Follow-up Scheduled');
                          }
                        }}
                        className="w-full px-3.5 py-2 text-sm font-mono font-semibold bg-white text-slate-950 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-amber-600"
                      />
                    </div>
                    <div>
                      <label htmlFor="staff-followup-time" className="block text-xs font-bold text-slate-800 mb-1">
                        Follow-Up Time (Samay)
                      </label>
                      <input
                        id="staff-followup-time"
                        type="time"
                        value={followUpTime}
                        onChange={(e) => {
                          setFollowUpTime(e.target.value);
                          if (e.target.value && (callStatus === 'Pending' || callStatus === 'Not Answered')) {
                            setCallStatus('Follow-up Scheduled');
                          }
                        }}
                        className="w-full px-3.5 py-2 text-sm font-mono font-semibold bg-white text-slate-950 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-amber-600"
                      />
                    </div>
                  </div>

                  {schedulePreview.hasSchedule && (
                    <p className="text-xs font-bold text-amber-950 flex items-center gap-1.5">
                      <Clock className="w-3.5 h-3.5 text-amber-700 shrink-0" />
                      Follow-Up Scheduled: <span className="underline">{schedulePreview.label}</span>
                    </p>
                  )}
                </div>

                {/* Remark Box ("Usne kya bola?") */}
                <div>
                  <label htmlFor="staff-call-remark" className="block text-sm font-extrabold text-slate-950 mb-1.5">
                    Call Remark (Student / Parent ne kya bola?) <span className="text-red-700">*</span>
                  </label>
                  <textarea
                    id="staff-call-remark"
                    rows={3}
                    maxLength={1000}
                    required
                    value={remark}
                    onChange={(e) => {
                      setRemark(e.target.value);
                      if (validationError && e.target.value.trim()) {
                        setValidationError(null);
                      }
                    }}
                    placeholder="Yahaan likhein ki baat karne par unhone kya bola (jaise: Papa bole kal 4 baje call karna, ₹5,000 fee jama karenge)..."
                    className={`w-full px-4 py-2.5 text-sm bg-white text-slate-950 placeholder:text-slate-400 border rounded-xl focus:outline-none focus:ring-2 ${
                      validationError
                        ? 'border-red-600 focus:ring-red-600'
                        : 'border-slate-300 focus:ring-slate-900'
                    }`}
                  />
                  {validationError && (
                    <p className="mt-1.5 text-xs font-bold text-red-700">{validationError}</p>
                  )}
                </div>

                {/* Call Outcome Status Selector */}
                <div>
                  <p className="text-xs font-bold uppercase tracking-wider text-slate-600 mb-2">
                    Call Status
                  </p>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    {CALL_STATUS_OPTIONS.map((opt) => (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() => setCallStatus(opt.value)}
                        className={`py-2 px-3 rounded-xl border text-xs font-bold transition-colors whitespace-nowrap ${
                          callStatus === opt.value
                            ? opt.activeClass
                            : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
                        }`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Save Action Footer */}
                <div className="pt-3.5 border-t border-slate-200 flex flex-col sm:flex-row items-stretch sm:items-center justify-end gap-2.5">
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => void handleSaveTask(false)}
                    className="inline-flex items-center justify-center gap-2 px-5 py-2.5 text-xs font-bold text-slate-900 bg-white border border-slate-300 hover:bg-slate-50 rounded-xl disabled:opacity-50 whitespace-nowrap"
                  >
                    <Save className="w-4 h-4" />
                    {saving ? 'Saving...' : 'Save Update'}
                  </button>
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => void handleSaveTask(true)}
                    className="inline-flex items-center justify-center gap-2 px-6 py-2.5 text-xs font-extrabold text-white btn-crimson-gloss rounded-xl disabled:opacity-50 whitespace-nowrap"
                  >
                    <CheckCircle2 className="w-4 h-4" />
                    {saving
                      ? 'Saving...'
                      : activeIndex < filteredTasks.length - 1
                        ? 'Save & Next Student →'
                        : 'Save Final Student'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

interface AdminWorkAssignmentsPanelProps {
  department: WorkAssignmentDepartment;
  currentUser: UserAccount;
  effectiveCentre: CentreId | 'all';
  assignments: WorkAssignment[];
  tasks: WorkAssignmentTask[];
  onOpenAssignModal: (prefill?: { staffUid?: string; fromSerial?: number }) => void;
  onNotify: (title: string, description: string, variant: 'success' | 'error' | 'warning' | 'info') => void;
}

export const AdminWorkAssignmentsPanel: React.FC<AdminWorkAssignmentsPanelProps> = ({
  department,
  currentUser,
  effectiveCentre,
  assignments,
  tasks,
  onOpenAssignModal,
  onNotify,
}) => {
  const [inspectingBatch, setInspectingBatch] = useState<WorkAssignment | null>(null);
  const [inspectFilter, setInspectFilter] = useState<'all' | 'followup' | 'done' | 'pending'>('all');
  const [busyBatchId, setBusyBatchId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);

  const scopedAssignments = useMemo(() => {
    return assignments
      .filter((a) => {
        if (a.department !== department) return false;
        if (effectiveCentre !== 'all' && a.centreId !== effectiveCentre) return false;
        if (!showArchived && a.status !== 'Active') return false;
        return true;
      })
      .sort((a, b) => {
        if (a.status === 'Active' && b.status !== 'Active') return -1;
        if (a.status !== 'Active' && b.status === 'Active') return 1;
        return b.assignedDate.localeCompare(a.assignedDate);
      });
  }, [assignments, department, effectiveCentre, showArchived]);

  const archivedCount = useMemo(
    () =>
      assignments.filter(
        (a) =>
          a.department === department &&
          (effectiveCentre === 'all' || a.centreId === effectiveCentre) &&
          a.status !== 'Active',
      ).length,
    [assignments, department, effectiveCentre],
  );

  const handleToggleArchive = async (batch: WorkAssignment) => {
    setBusyBatchId(batch.assignmentId);
    try {
      const nextStatus = batch.status === 'Active' ? 'Completed' : 'Active';
      await updateWorkAssignmentStatus(batch, nextStatus, currentUser);
      onNotify(
        nextStatus === 'Active' ? 'Batch Re-Activated' : 'Batch Marked Completed',
        `S.No #${batch.fromSerial}–#${batch.toSerial} (${batch.staffName}) is now ${nextStatus}.`,
        'success',
      );
    } catch (err) {
      onNotify('Update Failed', err instanceof Error ? err.message : 'Unable to update batch.', 'error');
    } finally {
      setBusyBatchId(null);
    }
  };

  const handleDeleteBatch = async (batch: WorkAssignment) => {
    setBusyBatchId(batch.assignmentId);
    try {
      await deleteWorkAssignmentBatch(batch, tasks, currentUser);
      setConfirmDeleteId(null);
      if (inspectingBatch?.assignmentId === batch.assignmentId) {
        setInspectingBatch(null);
      }
      onNotify(
        'Assignment Removed',
        `Deleted batch S.No #${batch.fromSerial}–#${batch.toSerial} for ${batch.staffName}.`,
        'success',
      );
    } catch (err) {
      onNotify('Delete Failed', err instanceof Error ? err.message : 'Unable to delete batch.', 'error');
    } finally {
      setBusyBatchId(null);
    }
  };

  const inspectTasks = useMemo(() => {
    if (!inspectingBatch) return [];
    return tasks
      .filter((t) => t.assignmentId === inspectingBatch.assignmentId)
      .filter((t) => {
        if (inspectFilter === 'followup') return t.callStatus === 'Follow-up Scheduled';
        if (inspectFilter === 'done') return t.callStatus === 'Called - Done';
        if (inspectFilter === 'pending') return t.callStatus === 'Pending' || t.callStatus === 'Not Answered';
        return true;
      })
      .sort((a, b) => (a.serialNumber || 0) - (b.serialNumber || 0));
  }, [inspectingBatch, tasks, inspectFilter]);

  const deptLabel = WORK_ASSIGNMENT_DEPARTMENT_LABELS[department];

  return (
    <div className="bg-white rounded-xl border border-slate-200 p-4 space-y-3">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-red-50 border border-red-200 text-red-700 flex items-center justify-center shrink-0">
            <ClipboardList className="w-4 h-4" />
          </div>
          <div>
            <h3 className="text-sm font-bold text-slate-950">
              Staff Calling Assignments — {deptLabel}
            </h3>
            <p className="text-[11px] text-slate-600">
              Excel sheet se manually tick karke ya 1–25 select karke staff ko assign karein. Aaj assign hue students kal auto-unlock ho jayenge.
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          {archivedCount > 0 && (
            <button
              type="button"
              onClick={() => setShowArchived((v) => !v)}
              className="px-3 py-1.5 text-xs font-semibold text-slate-700 bg-slate-50 border border-slate-300 rounded-lg hover:bg-slate-100 whitespace-nowrap"
            >
              {showArchived ? 'Hide Past Batches' : `Show Past (${archivedCount})`}
            </button>
          )}
          <button
            type="button"
            onClick={() => onOpenAssignModal()}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-bold text-white bg-slate-900 hover:bg-slate-800 rounded-lg whitespace-nowrap"
          >
            <Plus className="w-3.5 h-3.5" />
            Assign Work to Staff
          </button>
        </div>
      </div>

      {scopedAssignments.length === 0 ? (
        <div className="rounded-lg bg-slate-50 border border-dashed border-slate-300 px-4 py-3 text-xs text-slate-600 flex flex-wrap items-center justify-between gap-2">
          <span>No active calling batches assigned for {deptLabel} right now.</span>
          <button
            type="button"
            onClick={() => onOpenAssignModal()}
            className="text-red-700 font-bold hover:underline"
          >
            Select &amp; Assign Work now →
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {scopedAssignments.map((batch) => {
            const bTasks = tasks.filter((t) => t.assignmentId === batch.assignmentId);
            const prog = computeAssignmentProgress(bTasks);
            const isBusy = busyBatchId === batch.assignmentId;
            return (
              <div
                key={batch.assignmentId}
                className={`rounded-xl border p-3.5 space-y-2.5 ${
                  batch.status === 'Active' ? 'bg-white border-slate-200' : 'bg-slate-50 border-slate-200 opacity-85'
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-bold text-slate-950 truncate">{batch.staffName}</p>
                    <p className="text-[11px] font-mono text-slate-600">
                      S.No #{batch.fromSerial}–#{batch.toSerial} · {batch.totalStudents} Students · {CENTRE_MAP[batch.centreId]?.code}
                    </p>
                  </div>
                  <span
                    className={`text-[10px] font-extrabold uppercase shrink-0 ${
                      batch.status === 'Active' ? 'text-emerald-700' : 'text-slate-500'
                    }`}
                  >
                    {batch.status}
                  </span>
                </div>

                {/* Progress Bar & Metrics */}
                <div className="space-y-1">
                  <div className="w-full h-1.5 bg-slate-100 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-emerald-600 transition-all"
                      style={{ width: `${prog.percentDone}%` }}
                    />
                  </div>
                  <div className="flex items-center justify-between text-[11px] font-mono text-slate-600">
                    <span>Done: <strong className="text-emerald-700">{prog.completed}</strong></span>
                    <span>Follow-up: <strong className="text-amber-800">{prog.followUpScheduled}</strong></span>
                    <span>Pending: <strong className="text-slate-900">{prog.pending + prog.notAnswered}</strong></span>
                  </div>
                </div>

                {/* Controls */}
                <div className="pt-2 border-t border-slate-100 flex flex-wrap items-center justify-between gap-1.5">
                  <button
                    type="button"
                    onClick={() => {
                      setInspectFilter('all');
                      setInspectingBatch(batch);
                    }}
                    className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-bold text-slate-900 bg-slate-100 hover:bg-slate-200 rounded-md"
                  >
                    <Eye className="w-3.5 h-3.5" />
                    Remarks &amp; Follow-ups
                  </button>

                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() =>
                        onOpenAssignModal({
                          staffUid: batch.staffUid,
                          fromSerial: batch.toSerial + 1,
                        })
                      }
                      title="Assign next serial range to this staff"
                      className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-bold text-red-700 bg-red-50 hover:bg-red-100 border border-red-200 rounded-md"
                    >
                      <RefreshCw className="w-3 h-3" />
                      Re-Assign
                    </button>

                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => void handleToggleArchive(batch)}
                      className="px-2 py-1 text-[11px] font-semibold text-slate-700 bg-white border border-slate-300 hover:bg-slate-100 rounded-md"
                    >
                      {batch.status === 'Active' ? 'Complete' : 'Re-Open'}
                    </button>

                    {confirmDeleteId === batch.assignmentId ? (
                      <button
                        type="button"
                        disabled={isBusy}
                        onClick={() => void handleDeleteBatch(batch)}
                        className="px-2 py-1 text-[11px] font-bold text-white bg-red-700 hover:bg-red-800 rounded-md"
                      >
                        {isBusy ? '...' : 'Confirm'}
                      </button>
                    ) : (
                      <button
                        type="button"
                        disabled={isBusy}
                        onClick={() => setConfirmDeleteId(batch.assignmentId)}
                        aria-label={`Delete batch for ${batch.staffName}`}
                        title="Delete Batch"
                        className="p-1 text-slate-500 hover:text-red-700 rounded-md"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Batch Progress & Remarks Inspector Modal for Centre Head / Super Admin */}
      {inspectingBatch && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-[#040E24]/75 backdrop-blur-sm p-4"
          role="dialog"
          aria-modal="true"
        >
          <div className="bg-white rounded-2xl border border-slate-200 shadow-2xl max-w-4xl w-full max-h-[88vh] flex flex-col overflow-hidden">
            <div className="p-5 border-b border-slate-200 flex items-start justify-between gap-4">
              <div>
                <h3 className="text-base font-bold text-slate-950">
                  {inspectingBatch.staffName} — S.No #{inspectingBatch.fromSerial} to #{inspectingBatch.toSerial}
                </h3>
                <p className="text-xs text-slate-600 mt-0.5">
                  {deptLabel} · Assigned on {inspectingBatch.assignedDate} by {inspectingBatch.assignedByName}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setInspectingBatch(null)}
                aria-label="Close Batch Remarks Modal"
                className="p-1 text-slate-500 hover:text-slate-900 rounded-lg"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="px-5 py-3 border-b border-slate-100 bg-slate-50 flex flex-wrap items-center gap-2">
              {(
                [
                  { id: 'all', label: 'All Students' },
                  { id: 'followup', label: 'Follow-up Scheduled' },
                  { id: 'done', label: 'Completed' },
                  { id: 'pending', label: 'Pending / No Answer' },
                ] as const
              ).map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setInspectFilter(tab.id)}
                  className={`px-3 py-1.5 text-xs font-bold rounded-lg border ${
                    inspectFilter === tab.id
                      ? 'bg-slate-900 text-white border-slate-900'
                      : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-100'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            <div className="flex-1 overflow-y-auto divide-y divide-slate-100">
              {inspectTasks.length === 0 ? (
                <div className="p-8 text-center text-xs text-slate-500">
                  No students in this filter category.
                </div>
              ) : (
                inspectTasks.map((t) => {
                  const sched = formatFollowUpSchedule(t.followUpDate, t.followUpTime);
                  return (
                    <div key={t.taskId} className="p-4 flex flex-col sm:flex-row sm:items-start justify-between gap-3">
                      <div className="space-y-0.5 min-w-0">
                        <p className="text-sm font-bold text-slate-950">
                          <span className="font-mono text-slate-500 mr-1.5">#{t.serialNumber}</span>
                          {t.studentName}
                        </p>
                        <p className="text-xs text-slate-600">
                          Father: <strong className="text-slate-800">{t.fatherName || '—'}</strong> · Mobile:{' '}
                          <span className="font-mono">{t.callingNumber || t.mobileNumber || '—'}</span>
                        </p>
                        {t.remark ? (
                          <p className="text-xs text-slate-800 bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 mt-1.5">
                            <strong>Remark:</strong> {t.remark}
                          </p>
                        ) : (
                          <p className="text-[11px] text-slate-400 mt-1">No remark entered yet.</p>
                        )}
                      </div>
                      <div className="sm:text-right shrink-0 space-y-1">
                        <p
                          className={`text-xs font-bold ${
                            t.callStatus === 'Called - Done'
                              ? 'text-emerald-700'
                              : t.callStatus === 'Follow-up Scheduled'
                                ? 'text-amber-800'
                                : t.callStatus === 'Not Answered'
                                  ? 'text-rose-700'
                                  : 'text-slate-500'
                          }`}
                        >
                          {t.callStatus}
                        </p>
                        {sched.hasSchedule && (
                          <p className="text-xs font-mono font-semibold text-amber-900">
                            Follow-up: {sched.label}
                          </p>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
