import { ArrowRightLeft, Edit3, MapPin, MessageCircle, Phone, User, X } from 'lucide-react';
import React, { useState } from 'react';
import { CANONICAL_CENTRES } from '../constants/centres';
import { buildTelHref, buildWhatsAppHref, maskMobileNumber } from '../lib/analyticsMath';
import { formatDateTime } from '../lib/csvUtils';
import { isStudentDeptLockedForEmployee } from '../services/firestoreService';
import type { CentreId, Student, UserAccount } from '../types/domain';

interface StudentProfileModalProps {
  student: Student | null;
  displaySerial?: number;
  currentUser: UserAccount;
  onClose: () => void;
  onEdit: (student: Student) => void;
  onTransferCentre?: (student: Student, targetCentreId: CentreId) => Promise<void>;
}

export const StudentProfileModal: React.FC<StudentProfileModalProps> = ({
  student,
  displaySerial,
  currentUser,
  onClose,
  onEdit,
  onTransferCentre,
}) => {
  const [transferCentreId, setTransferCentreId] = useState<CentreId>(student?.centreId || 'vp_lookerganj');
  const [transferBusy, setTransferBusy] = useState(false);

  if (!student) return null;

  const canEdit =
    currentUser.role === 'super_admin'
      ? true
      : currentUser.role === 'centre_head'
        ? student.centreId === currentUser.centreId
        : student.centreId === currentUser.centreId &&
          ['admission', 'tma', 'practical', 'online_classes'].includes(currentUser.department) &&
          !isStudentDeptLockedForEmployee(student, currentUser.department);

  const handleTransfer = async () => {
    if (!onTransferCentre || transferCentreId === student.centreId) return;
    setTransferBusy(true);
    try {
      await onTransferCentre(student, transferCentreId);
      onClose();
    } finally {
      setTransferBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#090d1b]/75 backdrop-blur-sm p-4 overflow-y-auto">
      <div className="bg-white/95 backdrop-blur-xl rounded-2xl border border-slate-200 shadow-2xl max-w-4xl w-full my-8 overflow-hidden text-[#0F172A]">
        {/* Header — Obsidian-Crimson Glass */}
        <div className="glass-dark-panel text-white px-6 py-5 border-b border-rose-400/20 flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-xs text-[#FBBF24] font-mono font-bold">
              <span>Serial #{String(displaySerial ?? student.serialNumber).padStart(4, '0')}</span>
              <span aria-hidden="true" className="text-rose-300/40">·</span>
              <span className="text-white">{student.centreName}</span>
            </div>
            <h2 className="text-xl font-bold text-white mt-1">{student.studentName}</h2>
            <div className="flex flex-wrap items-center gap-4 mt-2 text-xs text-sky-100/90">
              <span className="inline-flex items-center gap-2 font-mono">
                <Phone className="w-3.5 h-3.5 text-[#F59E0B]" />
                <span>{maskMobileNumber(student.mobileNumber)}</span>
                {buildTelHref(student.mobileNumber) && (
                  <a
                    href={buildTelHref(student.mobileNumber)!}
                    aria-label={`Call ${student.studentName}`}
                    title="Direct Call"
                    className="p-1 rounded-md bg-emerald-500/20 text-emerald-300 hover:bg-emerald-500 hover:text-white border border-emerald-400/40 transition-colors"
                  >
                    <Phone className="w-3 h-3" />
                  </a>
                )}
                {buildWhatsAppHref(student.mobileNumber, student.studentName) && (
                  <a
                    href={buildWhatsAppHref(student.mobileNumber, student.studentName)!}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={`WhatsApp ${student.studentName}`}
                    title="Open WhatsApp Chat"
                    className="p-1 rounded-md bg-green-500/20 text-green-300 hover:bg-green-500 hover:text-white border border-green-400/40 transition-colors"
                  >
                    <MessageCircle className="w-3 h-3" />
                  </a>
                )}
              </span>
              <span className="inline-flex items-center gap-1.5">
                <MapPin className="w-3.5 h-3.5 text-[#F59E0B]" />
                Admitted {student.admissionDate}
              </span>
              <span className="inline-flex items-center gap-1.5">
                <User className="w-3.5 h-3.5 text-[#F59E0B]" />
                Assigned: {student.assignedEmployeeName || 'Unassigned'}
              </span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {canEdit && (
              <button
                type="button"
                onClick={() => onEdit(student)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold bg-[#F59E0B] hover:bg-amber-400 text-[#08152E] rounded-lg transition-colors whitespace-nowrap"
              >
                <Edit3 className="w-3.5 h-3.5" />
                Edit Profile
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 text-sky-200 hover:text-white rounded-lg"
              aria-label="Close student profile"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Body Sections — Crisp Frosted Surface */}
        <div className="p-6 space-y-6 max-h-[75vh] overflow-y-auto bg-white">
          <div>
            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-600 mb-3">
              Academic &amp; Assessment Statuses
            </h3>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
              {[
                { label: 'TC Status', value: student.tcStatus },
                { label: 'Book Status', value: student.bookStatus },
                { label: 'Live Classes', value: student.classAttendanceStatus },
                { label: 'TMA Status', value: student.tmaStatus },
                { label: 'Practical Status', value: student.practicalStatus },
                { label: 'Examination', value: student.examinationStatus },
              ].map((item) => (
                <div key={item.label} className="p-3 rounded-lg bg-slate-50 border border-slate-200">
                  <p className="text-[11px] font-medium text-slate-600">{item.label}</p>
                  <p className="text-xs font-bold text-[#08152E] mt-1">{item.value}</p>
                </div>
              ))}
            </div>
            {(student.tmaFee !== undefined || student.examFee !== undefined) && (
              <div className="grid grid-cols-2 gap-3 mt-3">
                <div className="p-3 rounded-lg bg-amber-50/70 border border-amber-200">
                  <p className="text-[11px] font-medium text-amber-900">TMA Fee</p>
                  <p className="text-sm font-mono font-bold text-amber-950 mt-0.5">
                    ₹{Number(student.tmaFee ?? 0).toLocaleString('en-IN')}
                  </p>
                </div>
                <div className="p-3 rounded-lg bg-indigo-50/70 border border-indigo-200">
                  <p className="text-[11px] font-medium text-indigo-900">Exam Fee</p>
                  <p className="text-sm font-mono font-bold text-indigo-950 mt-0.5">
                    ₹{Number(student.examFee ?? 0).toLocaleString('en-IN')}
                  </p>
                </div>
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            <div className="p-4 rounded-xl border border-slate-200 bg-white space-y-3">
              <div>
                <p className="text-xs font-bold text-slate-600">Enrolled Subjects</p>
                <p className="text-sm text-[#08152E] mt-1 font-semibold">{student.subject?.trim() || '—'}</p>
              </div>
              <div className="pt-3 border-t border-slate-200">
                <p className="text-xs font-bold text-slate-600">Why Admission in NIOS?</p>
                <p className="text-sm text-slate-700 mt-1 leading-relaxed">
                  {student.whyNios || 'No notes recorded.'}
                </p>
              </div>
            </div>

            <div className="p-4 rounded-xl border border-slate-200 bg-white space-y-3">
              <div>
                <p className="text-xs font-bold text-slate-600">Current Education Status</p>
                <p className="text-sm text-slate-700 mt-1 leading-relaxed">
                  {student.currentEducationStatus || 'No qualification details recorded.'}
                </p>
              </div>
              <div className="pt-3 border-t border-slate-200">
                <p className="text-xs font-bold text-slate-600">Future Planning &amp; Career Goals</p>
                <p className="text-sm text-slate-700 mt-1 leading-relaxed">
                  {student.futurePlanning || 'No future planning notes recorded.'}
                </p>
              </div>
            </div>
          </div>

          <div className="p-4 rounded-xl border border-slate-200 bg-slate-50 space-y-3">
            <div>
              <p className="text-xs font-bold text-slate-600">Additional Remarks &amp; Governance</p>
              <p className="text-sm text-[#08152E] mt-1">{student.additionalRemarks || 'None'}</p>
            </div>
            <div className="pt-3 border-t border-slate-200 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-slate-600 font-mono">
              <span>Created: {formatDateTime(student.createdAt)}</span>
              <span>Last Updated: {formatDateTime(student.updatedAt)}</span>
              <span>
                Dept Locks: ADM {student.admissionLocked ? 'Locked' : 'Open'} · TMA {student.tmaLocked ? 'Locked' : 'Open'} · PRC {student.practicalLocked ? 'Locked' : 'Open'} · CLS {student.onlineClassesLocked ? 'Locked' : 'Open'}
              </span>
              <span>Super Admin Edit: {student.superAdminAccessGranted === false ? 'Restricted' : 'Allowed'}</span>
            </div>
          </div>

          {student.extraColumns && Object.keys(student.extraColumns).length > 0 && (
            <div>
              <h3 className="text-xs font-bold uppercase tracking-wider text-slate-600 mb-3">
                Imported Excel Columns
              </h3>
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
                {Object.entries(student.extraColumns).map(([key, val]) => {
                  const displayVal = /mobile|phone|contact|whatsapp/i.test(key)
                    ? maskMobileNumber(val)
                    : val || '—';
                  return (
                    <div key={key} className="p-3 rounded-lg bg-slate-50 border border-slate-200">
                      <p className="text-[11px] font-medium text-slate-600 truncate" title={key}>
                        {key}
                      </p>
                      <p className="text-xs font-bold text-[#08152E] mt-1 break-words">{displayVal}</p>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {currentUser.role === 'super_admin' && onTransferCentre && (
            <div className="p-4 rounded-xl border border-slate-300 bg-slate-50 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div>
                <p className="text-sm font-bold text-[#08152E]">Super Admin Centre Transfer</p>
                <p className="text-xs text-slate-600 mt-0.5">
                  Reassign this student record to another Vision Point or Axis Academy branch.
                </p>
              </div>
              <div className="flex items-center gap-2.5">
                <select
                  value={transferCentreId}
                  onChange={(e) => setTransferCentreId(e.target.value as CentreId)}
                  className="px-3 py-2 text-xs bg-white border border-slate-300 rounded-lg text-[#08152E] font-medium focus:outline-none focus:ring-2 focus:ring-[#0F2F6B]"
                >
                  {CANONICAL_CENTRES.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  disabled={transferBusy || transferCentreId === student.centreId}
                  onClick={handleTransfer}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-white bg-[#0A224E] hover:bg-[#0F2F6B] rounded-lg disabled:opacity-50 whitespace-nowrap"
                >
                  <ArrowRightLeft className="w-3.5 h-3.5 text-[#F59E0B]" />
                  {transferBusy ? 'Transferring...' : 'Transfer Centre'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
