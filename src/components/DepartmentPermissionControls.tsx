import { CheckCircle2, Clock, Edit3, Send, X, XCircle } from 'lucide-react';
import React, { useState } from 'react';
import { DEPARTMENT_LABELS } from '../constants/centres';
import { createEditRequest, reviewEditRequest } from '../services/firestoreService';
import type { CentreId, DepartmentId, EditRequest, Student, UserAccount } from '../types/domain';

interface DepartmentPendingRequestsPanelProps {
  department: DepartmentId;
  editRequests: EditRequest[];
  currentUser: UserAccount;
  effectiveCentre: CentreId | 'all';
  onNotify: (title: string, description: string, variant: 'success' | 'error' | 'warning' | 'info') => void;
}

export const DepartmentPendingRequestsPanel: React.FC<DepartmentPendingRequestsPanelProps> = ({
  department,
  editRequests,
  currentUser,
  effectiveCentre,
  onNotify,
}) => {
  const [reviewNotes, setReviewNotes] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);

  if (currentUser.role !== 'centre_head' && currentUser.role !== 'super_admin') {
    return null;
  }

  const pending = editRequests.filter(
    (r) =>
      r.status === 'Pending' &&
      r.department === department &&
      (effectiveCentre === 'all' ? true : r.centreId === effectiveCentre),
  );

  if (pending.length === 0) return null;

  const handleReview = async (req: EditRequest, decision: 'Approved' | 'Rejected') => {
    setBusyId(req.requestId);
    try {
      await reviewEditRequest(req, decision, reviewNotes[req.requestId] || '', currentUser);
      onNotify(
        decision === 'Approved' ? 'Permission Approved' : 'Permission Rejected',
        decision === 'Approved'
          ? `Unlocked ${DEPARTMENT_LABELS[department] || department} for 1 correction edit on ${req.studentName}.`
          : `Rejected ${req.requesterName}'s edit request for ${req.studentName}.`,
        decision === 'Approved' ? 'success' : 'info',
      );
    } catch (err) {
      onNotify('Review Failed', err instanceof Error ? err.message : 'Unable to review request.', 'error');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="bg-amber-50/90 rounded-xl border border-amber-300 p-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Clock className="w-4 h-4 text-amber-800" />
          <h3 className="text-sm font-bold text-[#08152E]">
            Pending {DEPARTMENT_LABELS[department] || department} Edit Requests ({pending.length})
          </h3>
        </div>
        <span className="text-[11px] font-mono text-amber-900">
          Approve to allow 1 correction edit by employee
        </span>
      </div>

      <div className="space-y-2">
        {pending.map((req) => {
          const busy = busyId === req.requestId;
          return (
            <div
              key={req.requestId}
              className="bg-white rounded-lg border border-amber-200 p-3 flex flex-col lg:flex-row lg:items-center justify-between gap-3"
            >
              <div className="space-y-1 min-w-0">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="font-bold text-[#08152E]">{req.studentName}</span>
                  <span className="font-mono text-slate-600">#{req.serialNumber}</span>
                  <span className="text-slate-600">
                    requested by <strong className="text-[#08152E]">{req.requesterName}</strong>
                  </span>
                </div>
                <p className="text-xs text-slate-700">
                  <span className="font-semibold text-[#08152E]">Reason:</span> &ldquo;{req.reason}&rdquo;
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2 shrink-0">
                <input
                  type="text"
                  value={reviewNotes[req.requestId] || ''}
                  onChange={(e) =>
                    setReviewNotes((prev) => ({ ...prev, [req.requestId]: e.target.value }))
                  }
                  placeholder="Optional note..."
                  className="px-2.5 py-1.5 text-xs bg-white text-[#08152E] border border-slate-300 rounded-lg w-40 focus:outline-none focus:ring-2 focus:ring-[#0F2F6B]"
                />
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => handleReview(req, 'Approved')}
                  className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-bold text-white bg-emerald-700 hover:bg-emerald-800 rounded-lg disabled:opacity-50"
                >
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  {busy ? 'Saving...' : 'Approve (1 Edit)'}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => handleReview(req, 'Rejected')}
                  className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-bold text-red-800 bg-red-50 hover:bg-red-100 border border-red-200 rounded-lg disabled:opacity-50"
                >
                  <XCircle className="w-3.5 h-3.5" />
                  Reject
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

interface AskEditPermissionModalProps {
  student: Student | null;
  department: DepartmentId;
  currentUser: UserAccount;
  onClose: () => void;
  onNotify: (title: string, description: string, variant: 'success' | 'error' | 'warning' | 'info') => void;
}

export const AskEditPermissionModal: React.FC<AskEditPermissionModalProps> = ({
  student,
  department,
  currentUser,
  onClose,
  onNotify,
}) => {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!student) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const clean = reason.trim();
    if (clean.length < 3) {
      setError('Please explain what needs to be corrected (at least 3 characters).');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await createEditRequest({ student, department, reason: clean }, currentUser);
      onNotify(
        'Permission Request Sent',
        `Sent ${DEPARTMENT_LABELS[department] || department} edit request for ${student.studentName} to your Centre Head.`,
        'success',
      );
      setReason('');
      onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unable to send permission request.';
      setError(msg);
      onNotify('Request Failed', msg, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#090d1b]/75 backdrop-blur-sm p-4">
      <div className="bg-white rounded-2xl border border-slate-200 shadow-2xl max-w-md w-full p-6 text-[#0F172A]">
        <div className="flex items-start justify-between pb-3 border-b border-slate-200">
          <div>
            <h3 className="text-base font-bold text-[#08152E]">Ask Centre Head Edit Permission</h3>
            <p className="text-xs text-slate-600 font-mono mt-0.5">
              {student.studentName} (#{student.serialNumber}) · {DEPARTMENT_LABELS[department] || department}
            </p>
          </div>
          <button type="button" onClick={onClose} className="text-slate-500 hover:text-[#08152E] p-1">
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="mt-4 space-y-4">
          {error && (
            <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-900">{error}</div>
          )}
          <div>
            <label className="block text-xs font-semibold text-[#08152E] mb-1">
              Reason for Correction (sent to Centre Head)
            </label>
            <textarea
              rows={3}
              required
              minLength={3}
              maxLength={500}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Explain what mistake happened and why you need 1 correction edit..."
              className="w-full px-3 py-2 text-sm bg-white text-[#08152E] placeholder:text-slate-400 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#0F2F6B]"
            />
          </div>
          <div className="flex justify-end gap-2.5 pt-2">
            <button
              type="button"
              disabled={busy}
              onClick={onClose}
              className="px-4 py-2 text-xs font-semibold text-[#08152E] bg-white border border-slate-300 rounded-lg hover:bg-slate-100"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-bold text-white btn-crimson-gloss rounded-lg disabled:opacity-50"
            >
              <Send className="w-3.5 h-3.5" />
              {busy ? 'Sending...' : 'Send Permission Request'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

interface DepartmentRowActionButtonProps {
  lockedForEmployee: boolean;
  hasPendingRequest: boolean;
  editLabel: string;
  onEdit: () => void;
  onAskPermission: () => void;
}

export const DepartmentRowActionButton: React.FC<DepartmentRowActionButtonProps> = ({
  lockedForEmployee,
  hasPendingRequest,
  editLabel,
  onEdit,
  onAskPermission,
}) => {
  if (!lockedForEmployee) {
    return (
      <button
        type="button"
        onClick={onEdit}
        className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold text-black bg-zinc-100 hover:bg-zinc-200 rounded-md"
      >
        <Edit3 className="w-3.5 h-3.5" />
        {editLabel}
      </button>
    );
  }

  if (hasPendingRequest) {
    return (
      <span className="inline-flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-bold bg-amber-100 text-amber-900 rounded-md">
        <Clock className="w-3.5 h-3.5" />
        Permission Pending
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={onAskPermission}
      className="inline-flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-bold text-[#B45309] bg-amber-50 hover:bg-amber-100 border border-amber-200 rounded-md"
    >
      <Send className="w-3.5 h-3.5" />
      Ask Permission
    </button>
  );
};
