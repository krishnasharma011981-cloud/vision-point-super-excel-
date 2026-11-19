import {
  Building2,
  CheckCircle2,
  Clock,
  Plus,
  Search,
  Shield,
  Trash2,
  UserCheck,
  UserPlus,
  UserX,
  X,
} from 'lucide-react';
import React, { useMemo, useState } from 'react';
import { CANONICAL_CENTRES, CENTRE_MAP, DEPARTMENT_LABELS, DEPARTMENTS, ROLE_LABELS } from '../constants/centres';
import { canDeleteStaffMember, canManageStaffMember } from '../lib/deleteSecurity';
import { provisionAuthUserOnServer } from '../lib/securityClient';
import {
  assignCentreHead,
  createStaffInvite,
  deleteStaffInvite,
  deleteStaffMember,
  saveUserAccountDoc,
  updateUserAccount,
} from '../services/firestoreService';
import { DeleteProtectionModal } from './DeleteProtectionModal';
import type {
  AccountStatus,
  CentreId,
  StaffInvite,
  UserAccount,
  UserDepartment,
  UserRole,
} from '../types/domain';

interface EmployeeManagementViewProps {
  currentUser: UserAccount;
  users: UserAccount[];
  staffInvites: StaffInvite[];
  selectedCentreFilter: CentreId | 'all';
  onNotify: (title: string, description: string, variant: 'success' | 'error' | 'warning' | 'info') => void;
}

export const EmployeeManagementView: React.FC<EmployeeManagementViewProps> = ({
  currentUser,
  users,
  staffInvites,
  selectedCentreFilter,
  onNotify,
}) => {
  const isSuperAdmin = currentUser.role === 'super_admin';

  const [activeCentreTab, setActiveCentreTab] = useState<CentreId | 'all'>(
    isSuperAdmin ? selectedCentreFilter : currentUser.centreId,
  );
  const [deptFilter, setDeptFilter] = useState<UserDepartment | 'all'>('all');
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState('all');
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [editingUser, setEditingUser] = useState<UserAccount | null>(null);
  const [deleteTargetUser, setDeleteTargetUser] = useState<UserAccount | null>(null);
  const [deletingStaff, setDeletingStaff] = useState(false);

  // Create form state
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [mobileNumber, setMobileNumber] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<UserRole>('employee');
  const [centreId, setCentreId] = useState<CentreId>(
    isSuperAdmin && activeCentreTab !== 'all' ? activeCentreTab : currentUser.centreId,
  );
  const [department, setDepartment] = useState<UserDepartment>('admission');
  const [joiningDate, setJoiningDate] = useState(new Date().toISOString().slice(0, 10));
  const [busy, setBusy] = useState(false);

  // Edit form state
  const [editName, setEditName] = useState('');
  const [editMobile, setEditMobile] = useState('');
  const [editDept, setEditDept] = useState<UserDepartment>('admission');
  const [editStatus, setEditStatus] = useState<AccountStatus>('Active');
  const [editCentre, setEditCentre] = useState<CentreId>('vp_lookerganj');
  const [editRole, setEditRole] = useState<UserRole>('employee');

  const effectiveCentreTab: CentreId | 'all' = isSuperAdmin ? activeCentreTab : currentUser.centreId;

  const scopedUsers = useMemo(() => {
    return users
      .filter((u) => (effectiveCentreTab === 'all' ? true : u.centreId === effectiveCentreTab))
      .filter((u) => (roleFilter === 'all' ? true : u.role === roleFilter))
      .filter((u) => (deptFilter === 'all' ? true : u.department === deptFilter))
      .filter((u) => {
        if (!search.trim()) return true;
        const q = search.trim().toLowerCase();
        return (
          u.fullName.toLowerCase().includes(q) ||
          u.email.toLowerCase().includes(q) ||
          u.mobileNumber.toLowerCase().includes(q)
        );
      });
  }, [users, effectiveCentreTab, roleFilter, deptFilter, search]);

  const pendingInvites = useMemo(() => {
    return staffInvites
      .filter((inv) => inv.status === 'Pending')
      .filter((inv) => (effectiveCentreTab === 'all' ? true : inv.centreId === effectiveCentreTab))
      .filter((inv) => (roleFilter === 'all' ? true : inv.role === roleFilter))
      .filter((inv) => (deptFilter === 'all' ? true : inv.department === deptFilter))
      .filter((inv) => {
        if (!search.trim()) return true;
        const q = search.trim().toLowerCase();
        return (
          inv.fullName.toLowerCase().includes(q) ||
          inv.email.toLowerCase().includes(q) ||
          inv.mobileNumber.toLowerCase().includes(q)
        );
      });
  }, [staffInvites, effectiveCentreTab, roleFilter, deptFilter, search]);

  const openProvisionModal = (defaultRole: 'employee' | 'centre_head', targetCentre?: CentreId) => {
    const resolvedCentre =
      targetCentre ||
      (isSuperAdmin && effectiveCentreTab !== 'all' ? effectiveCentreTab : currentUser.centreId);
    setRole(isSuperAdmin ? defaultRole : 'employee');
    setCentreId(resolvedCentre);
    setDepartment(defaultRole === 'centre_head' ? 'all' : 'admission');
    setShowCreateModal(true);
  };

  const handleCreateUser = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanEmail = email.trim().toLowerCase();
    if (!fullName.trim() || !cleanEmail || password.length < 6) {
      onNotify('Validation Error', 'Name, valid email, and password (min 6 chars) are required.', 'error');
      return;
    }

    const existingStaff = users.find((u) => u.email.trim().toLowerCase() === cleanEmail);
    if (existingStaff) {
      onNotify(
        'Staff Already Exists',
        `${existingStaff.fullName} (${existingStaff.email}) is already registered in Active Staff. Click "Edit" on their row below to update Role, Centre, or Status.`,
        'warning',
      );
      return;
    }

    const finalRole: 'centre_head' | 'employee' = isSuperAdmin && role === 'centre_head' ? 'centre_head' : 'employee';
    const finalCentre: CentreId = isSuperAdmin ? centreId : currentUser.centreId;
    const finalDept: UserDepartment = finalRole === 'employee' ? (department === 'all' ? 'admission' : department) : 'all';

    setBusy(true);
    try {
      const provisioned = await provisionAuthUserOnServer({
        email: cleanEmail,
        password,
        fullName: fullName.trim(),
        role: finalRole,
        centreId: finalCentre,
        department: finalDept,
      });

      if (provisioned.mode === 'invite_fallback') {
        await createStaffInvite(
          {
            fullName: fullName.trim(),
            email: cleanEmail,
            mobileNumber: mobileNumber.trim(),
            role: finalRole,
            centreId: finalCentre,
            department: finalDept,
            joiningDate,
          },
          currentUser,
        );

        onNotify(
          provisioned.reason === 'email_exists'
            ? `${ROLE_LABELS[finalRole]} Pre-Authorized`
            : `${ROLE_LABELS[finalRole]} Authorized`,
          provisioned.reason === 'email_exists'
            ? `${cleanEmail} already exists in Firebase Auth. Saved as Pre-Authorized Invite for ${CENTRE_MAP[finalCentre].name} — ask ${fullName.trim()} to select "${CENTRE_MAP[finalCentre].name}" and log in with their Email & Password to activate.`
            : `${fullName.trim()} (${cleanEmail}) assigned to ${CENTRE_MAP[finalCentre].name}${
                finalRole === 'employee' ? ` (${DEPARTMENT_LABELS[finalDept]})` : ''
              }. Ask them to select "${CENTRE_MAP[finalCentre].name}" and log in with their Email & Password.`,
          'success',
        );
      } else {
        await saveUserAccountDoc(
          {
            uid: provisioned.uid,
            fullName: fullName.trim(),
            email: provisioned.email,
            mobileNumber: mobileNumber.trim(),
            role: finalRole,
            centreId: finalCentre,
            centreName: CENTRE_MAP[finalCentre].name,
            department: finalDept,
            status: 'Active',
            joiningDate,
            createdBy: currentUser.uid,
            updatedBy: currentUser.uid,
          },
          currentUser,
        );

        onNotify(
          'Account Provisioned',
          `Created ${ROLE_LABELS[finalRole]} account for ${fullName.trim()} in ${CENTRE_MAP[finalCentre].name}. They can log in directly using this Email ID and Password (no email verification required).`,
          'success',
        );
      }

      setShowCreateModal(false);
      setFullName('');
      setEmail('');
      setMobileNumber('');
      setPassword('');
    } catch (err) {
      onNotify('Provisioning Failed', err instanceof Error ? err.message : 'Unable to create account.', 'error');
    } finally {
      setBusy(false);
    }
  };

  const openEditModal = (u: UserAccount) => {
    setEditingUser(u);
    setEditName(u.fullName);
    setEditMobile(u.mobileNumber);
    setEditDept(u.department);
    setEditStatus(u.status);
    setEditCentre(u.centreId);
    setEditRole(u.role);
  };

  const handleSaveEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingUser) return;
    setBusy(true);
    try {
      if (isSuperAdmin && editRole === 'centre_head' && (editingUser.role !== 'centre_head' || editingUser.centreId !== editCentre)) {
        await assignCentreHead(
          editCentre,
          {
            ...editingUser,
            fullName: editName.trim(),
            mobileNumber: editMobile.trim(),
            status: editStatus,
          },
          currentUser,
        );
      }

      const nextDept: UserDepartment =
        isSuperAdmin && editRole !== 'employee' ? 'all' : editDept === 'all' ? 'admission' : editDept;

      const updates = isSuperAdmin
        ? {
            fullName: editName.trim(),
            mobileNumber: editMobile.trim(),
            role: editRole,
            centreId: editCentre,
            centreName: CENTRE_MAP[editCentre].name,
            department: nextDept,
            status: editStatus,
          }
        : {
            fullName: editName.trim(),
            mobileNumber: editMobile.trim(),
            department: nextDept,
            status: editStatus,
          };

      await updateUserAccount(editingUser.uid, updates, currentUser, isSuperAdmin ? editCentre : currentUser.centreId);
      onNotify('Staff Profile Updated', `Updated permissions and status for ${editName.trim()}.`, 'success');
      setEditingUser(null);
    } catch (err) {
      onNotify('Update Failed', err instanceof Error ? err.message : 'Could not update user.', 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleToggleStatus = async (u: UserAccount) => {
    if (u.uid === currentUser.uid) {
      onNotify('Action Blocked', 'You cannot deactivate your own active session.', 'warning');
      return;
    }
    const nextStatus: AccountStatus = u.status === 'Active' ? 'Inactive' : 'Active';
    try {
      await updateUserAccount(u.uid, { status: nextStatus }, currentUser, u.centreId);
      onNotify('Status Changed', `${u.fullName} is now ${nextStatus}.`, 'info');
    } catch (err) {
      onNotify('Status Update Failed', err instanceof Error ? err.message : 'Operation denied.', 'error');
    }
  };

  const handleCancelInvite = async (inv: StaffInvite) => {
    try {
      await deleteStaffInvite(inv.inviteId, inv.email, inv.centreId, currentUser);
      onNotify('Invite Removed', `Removed pending staff invite for ${inv.email}.`, 'info');
    } catch (err) {
      onNotify('Remove Failed', err instanceof Error ? err.message : 'Could not remove invite.', 'error');
    }
  };

  const handleConfirmDeleteStaff = async () => {
    if (!deleteTargetUser) return;
    setDeletingStaff(true);
    try {
      await deleteStaffMember(deleteTargetUser, currentUser);
      onNotify(
        'Staff Removed',
        `${deleteTargetUser.fullName} (${deleteTargetUser.email}) has been permanently removed from ${deleteTargetUser.centreName}.`,
        'success',
      );
      if (editingUser?.uid === deleteTargetUser.uid) {
        setEditingUser(null);
      }
      setDeleteTargetUser(null);
    } catch (err) {
      onNotify('Delete Failed', err instanceof Error ? err.message : 'Could not delete staff member.', 'error');
    } finally {
      setDeletingStaff(false);
    }
  };

  const selectedCentreMeta = effectiveCentreTab !== 'all' ? CENTRE_MAP[effectiveCentreTab] : null;
  const activeHeadInSelectedCentre = selectedCentreMeta
    ? users.find((u) => u.centreId === selectedCentreMeta.id && u.role === 'centre_head')
    : null;
  const pendingHeadInSelectedCentre = selectedCentreMeta
    ? staffInvites.find((inv) => inv.centreId === selectedCentreMeta.id && inv.role === 'centre_head' && inv.status === 'Pending')
    : null;

  // Lookup current head for the modal's selected centreId
  const modalCentreHead = users.find((u) => u.centreId === centreId && u.role === 'centre_head');
  const modalPendingHead = staffInvites.find(
    (inv) => inv.centreId === centreId && inv.role === 'centre_head' && inv.status === 'Pending',
  );

  return (
    <div className="space-y-5">
      {/* Header Banner */}
      <div className="bg-white rounded-2xl border border-zinc-200 p-5 sm:p-6 flex flex-col lg:flex-row lg:items-center justify-between gap-4 shadow-xs">
        <div>
          <h2 className="text-lg font-extrabold text-black">Centre-Wise Staff &amp; Leadership Management</h2>
          <p className="text-xs text-zinc-700 mt-0.5">
            {isSuperAdmin
              ? 'Select any of the four centres below to add department employees or assign a Centre Head specifically to that branch.'
              : `Add and manage department employees (Fee Recovery, Practical, TMA, Online Classes, Admission) within ${CENTRE_MAP[currentUser.centreId]?.name}.`}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2.5">
          {isSuperAdmin && (
            <button
              type="button"
              onClick={() => openProvisionModal('centre_head')}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-bold text-black bg-[#F59E0B] hover:bg-amber-400 rounded-xl whitespace-nowrap transition-colors"
            >
              <UserPlus className="w-3.5 h-3.5 text-black" />
              Assign Centre Head
            </button>
          )}
          <button
            type="button"
            onClick={() => openProvisionModal('employee')}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-bold text-white btn-crimson-gloss rounded-xl whitespace-nowrap transition-all"
          >
            <Plus className="w-3.5 h-3.5" />
            {selectedCentreMeta ? `Add Employee to ${selectedCentreMeta.code}` : 'Add Employee'}
          </button>
        </div>
      </div>

      {/* 4-Centre Selector Tabs for Super Admin */}
      {isSuperAdmin && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
          <button
            type="button"
            onClick={() => setActiveCentreTab('all')}
            className={`text-left p-3.5 rounded-xl border transition-all ${
              effectiveCentreTab === 'all'
                ? 'glass-dark-panel text-white border-[#EF4444] shadow-md'
                : 'glass-light-card text-slate-900 border-slate-300/80 hover:border-[#DC2626]'
            }`}
          >
            <p className={`text-[11px] font-mono font-bold ${effectiveCentreTab === 'all' ? 'text-[#FBBF24]' : 'text-[#B91C1C]'}`}>
              ALL BRANCHES
            </p>
            <p className="text-xs font-bold mt-0.5 truncate">All 4 Centres</p>
            <p className={`text-[11px] mt-1 font-mono ${effectiveCentreTab === 'all' ? 'text-slate-200/85' : 'text-slate-600'}`}>
              {users.length} active · {staffInvites.filter((i) => i.status === 'Pending').length} pending
            </p>
          </button>

          {CANONICAL_CENTRES.map((c) => {
            const selected = effectiveCentreTab === c.id;
            const cCount = users.filter((u) => u.centreId === c.id).length;
            const cPending = staffInvites.filter((i) => i.centreId === c.id && i.status === 'Pending').length;
            return (
              <button
                key={c.id}
                type="button"
                onClick={() => setActiveCentreTab(c.id)}
                className={`text-left p-3.5 rounded-xl border transition-all ${
                  selected
                    ? 'glass-dark-panel text-white border-[#EF4444] shadow-md'
                    : 'glass-light-card text-slate-900 border-slate-300/80 hover:border-[#DC2626]'
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className={`text-[11px] font-mono font-bold ${selected ? 'text-[#FBBF24]' : 'text-[#B91C1C]'}`}>
                    {c.code}
                  </span>
                  <Building2 className={`w-3.5 h-3.5 ${selected ? 'text-[#FBBF24]' : 'text-slate-600'}`} />
                </div>
                <p className="text-xs font-bold mt-0.5 truncate">{c.name}</p>
                <p className={`text-[11px] mt-1 font-mono ${selected ? 'text-slate-200/85' : 'text-slate-600'}`}>
                  {cCount} active · {cPending} pending
                </p>
              </button>
            );
          })}
        </div>
      )}

      {/* Selected Centre Leadership Summary Card */}
      {selectedCentreMeta && (
        <div className="glass-dark-panel text-white border border-rose-400/25 rounded-2xl p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="text-xs">
            <p className="font-bold text-[#F59E0B] uppercase tracking-wider text-[11px]">
              Selected Branch: {selectedCentreMeta.name} ({selectedCentreMeta.code})
            </p>
            <p className="text-sky-100 mt-1">
              Centre Head:{' '}
              {activeHeadInSelectedCentre ? (
                <strong className="text-white">
                  {activeHeadInSelectedCentre.fullName} ({activeHeadInSelectedCentre.email})
                </strong>
              ) : pendingHeadInSelectedCentre ? (
                <strong className="text-amber-300">
                  {pendingHeadInSelectedCentre.fullName} ({pendingHeadInSelectedCentre.email}) — Pending First Login
                </strong>
              ) : (
                <span className="text-sky-200/70">Not assigned yet</span>
              )}
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {isSuperAdmin && (
              <button
                type="button"
                onClick={() => openProvisionModal('centre_head', selectedCentreMeta.id)}
                className="px-3 py-1.5 text-xs font-bold bg-[#F59E0B] text-slate-950 rounded-lg hover:bg-amber-400 transition-colors"
              >
                + Assign Head
              </button>
            )}
            <button
              type="button"
              onClick={() => openProvisionModal('employee', selectedCentreMeta.id)}
              className="px-3 py-1.5 text-xs font-semibold bg-white/10 border border-sky-300/30 text-white rounded-lg hover:bg-white/20 transition-colors"
            >
              + Add Employee Here
            </button>
          </div>
        </div>
      )}

      {/* Search & Department/Role Filters */}
      <div className="bg-white rounded-xl border border-zinc-200 p-4 flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[220px]">
          <Search className="w-4 h-4 text-zinc-600 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search staff by name, email, or mobile..."
            className="w-full pl-9 pr-3.5 py-2 text-sm bg-white text-black placeholder:text-zinc-500 border border-zinc-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-black focus:border-black"
          />
        </div>
        <select
          value={deptFilter}
          onChange={(e) => setDeptFilter(e.target.value as UserDepartment | 'all')}
          className="px-3 py-2 text-sm border border-zinc-300 rounded-lg bg-white text-black font-medium focus:outline-none focus:ring-2 focus:ring-black"
        >
          <option value="all">All Departments (6)</option>
          {DEPARTMENTS.map((d) => (
            <option key={d.id} value={d.id}>
              {d.label}
            </option>
          ))}
        </select>
        <select
          value={roleFilter}
          onChange={(e) => setRoleFilter(e.target.value)}
          className="px-3 py-2 text-sm border border-zinc-300 rounded-lg bg-white text-black font-medium focus:outline-none focus:ring-2 focus:ring-black"
        >
          <option value="all">All Roles</option>
          {isSuperAdmin && <option value="super_admin">Super Admin</option>}
          <option value="centre_head">Centre Heads</option>
          <option value="employee">Department Employees</option>
        </select>
      </div>

      {/* Pending Activation Invites */}
      {pendingInvites.length > 0 && (
        <div className="bg-white rounded-xl border border-amber-400 overflow-hidden shadow-xs">
          <div className="px-5 py-3 bg-amber-50 border-b border-amber-200 flex items-center justify-between">
            <div className="flex items-center gap-2 text-xs font-bold text-black">
              <Clock className="w-4 h-4 text-[#B45309]" />
              Pre-Authorized Staff Invites (Select assigned centre &amp; log in with Email &amp; Password to activate)
            </div>
            <span className="text-xs font-mono font-bold text-black">{pendingInvites.length} pending</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-zinc-50 border-b border-zinc-200 text-[11px] font-bold text-zinc-700 uppercase tracking-wider">
                  <th className="py-2.5 px-4">Invited Staff</th>
                  <th className="py-2.5 px-4">Assigned Role</th>
                  <th className="py-2.5 px-4">Assigned Centre</th>
                  <th className="py-2.5 px-4">Department</th>
                  <th className="py-2.5 px-4">Activation</th>
                  <th className="py-2.5 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-200 text-xs">
                {pendingInvites.map((inv) => (
                  <tr key={inv.inviteId} className="hover:bg-amber-50/40">
                    <td className="py-3 px-4">
                      <p className="font-semibold text-black">{inv.fullName}</p>
                      <p className="text-[11px] text-zinc-700">
                        {inv.email} · <span className="font-mono">{inv.mobileNumber || 'No mobile'}</span>
                      </p>
                    </td>
                    <td className="py-3 px-4 font-semibold text-black">{ROLE_LABELS[inv.role]}</td>
                    <td className="py-3 px-4 text-zinc-800">{inv.centreName}</td>
                    <td className="py-3 px-4 text-zinc-800">{DEPARTMENT_LABELS[inv.department]}</td>
                    <td className="py-3 px-4">
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-amber-100 text-black font-semibold text-[11px]">
                        <CheckCircle2 className="w-3 h-3 text-[#B45309]" /> Pending Activation
                      </span>
                    </td>
                    <td className="py-3 px-4 text-right">
                      <button
                        type="button"
                        onClick={() => handleCancelInvite(inv)}
                        className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold text-red-700 hover:bg-red-50 rounded-md"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Active Staff Table */}
      <div className="bg-white rounded-xl border border-zinc-200 overflow-hidden shadow-xs">
        {scopedUsers.length === 0 ? (
          <div className="p-10 text-center text-xs text-zinc-700">
            <Shield className="w-8 h-8 text-zinc-400 mx-auto mb-2" />
            No active staff accounts match your current centre or filter.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-zinc-200 bg-zinc-50 text-[11px] font-bold text-zinc-700 uppercase tracking-wider">
                  <th className="py-3 px-4">Staff Member</th>
                  <th className="py-3 px-4">Role</th>
                  <th className="py-3 px-4">Assigned Centre</th>
                  <th className="py-3 px-4">Department</th>
                  <th className="py-3 px-4">Joining Date</th>
                  <th className="py-3 px-4">Status</th>
                  <th className="py-3 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-200 text-xs">
                {scopedUsers.map((u) => {
                  const canManageRow = canManageStaffMember(currentUser, u);
                  const canDeleteRow = canDeleteStaffMember(currentUser, u);
                  return (
                    <tr key={u.uid} className="hover:bg-zinc-50">
                      <td className="py-3 px-4">
                        <p className="font-semibold text-black">{u.fullName}</p>
                        <p className="text-[11px] text-zinc-700">
                          {u.email} · <span className="font-mono">{u.mobileNumber || 'No mobile'}</span>
                        </p>
                      </td>
                      <td className="py-3 px-4 font-semibold text-black">{ROLE_LABELS[u.role]}</td>
                      <td className="py-3 px-4 text-zinc-800">{u.centreName}</td>
                      <td className="py-3 px-4 text-zinc-800">{DEPARTMENT_LABELS[u.department]}</td>
                      <td className="py-3 px-4 font-mono text-zinc-700">{u.joiningDate}</td>
                      <td className="py-3 px-4">
                        <span
                          className={`font-semibold ${
                            u.status === 'Active' ? 'text-emerald-700' : 'text-red-700'
                          }`}
                        >
                          {u.status}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-right whitespace-nowrap">
                        {canManageRow ? (
                          <div className="inline-flex items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() => openEditModal(u)}
                              className="px-2.5 py-1 text-xs font-semibold text-black bg-zinc-100 hover:bg-zinc-200 rounded-md transition-colors"
                            >
                              Edit
                            </button>
                            {u.uid !== currentUser.uid && (
                              <button
                                type="button"
                                onClick={() => handleToggleStatus(u)}
                                className={`inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold rounded-md ${
                                  u.status === 'Active'
                                    ? 'text-amber-800 hover:bg-amber-50'
                                    : 'text-emerald-700 hover:bg-emerald-50'
                                }`}
                              >
                                {u.status === 'Active' ? (
                                  <>
                                    <UserX className="w-3.5 h-3.5" /> Deactivate
                                  </>
                                ) : (
                                  <>
                                    <UserCheck className="w-3.5 h-3.5" /> Activate
                                  </>
                                )}
                              </button>
                            )}
                            {canDeleteRow && (
                              <button
                                type="button"
                                onClick={() => setDeleteTargetUser(u)}
                                title={`Permanently delete ${u.fullName}`}
                                className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold text-red-700 bg-red-50 hover:bg-red-100 rounded-md transition-colors"
                              >
                                <Trash2 className="w-3.5 h-3.5" /> Delete
                              </button>
                            )}
                          </div>
                        ) : (
                          <span className="text-[11px] text-zinc-600">Protected</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Create User Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#040E24]/75 backdrop-blur-md p-4">
          <div className="glass-light-card rounded-2xl border border-slate-200 shadow-2xl max-w-lg w-full p-6 text-slate-900">
            <div className="flex items-start justify-between pb-3 border-b border-zinc-200">
              <div>
                <h3 className="text-base font-bold text-black">
                  {role === 'centre_head' ? 'Assign & Provision Centre Head' : 'Add Branch Employee'}
                </h3>
                <p className="text-xs text-zinc-700 mt-0.5">
                  {role === 'centre_head'
                    ? 'Select which branch this Centre Head will manage and provide their login email address.'
                    : 'Choose the assigned centre and single department for this employee.'}
                </p>
              </div>
              <button type="button" onClick={() => setShowCreateModal(false)} className="text-zinc-600 hover:text-black">
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleCreateUser} className="mt-4 space-y-3.5">
              {/* Role & Explicit Centre Selection Highlight Card */}
              <div className="p-3.5 rounded-xl bg-zinc-50 border border-zinc-200 space-y-3">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-bold text-black mb-1">1. Account Role</label>
                    <select
                      disabled={!isSuperAdmin}
                      value={isSuperAdmin ? role : 'employee'}
                      onChange={(e) => {
                        const nextRole = e.target.value as UserRole;
                        setRole(nextRole);
                        if (nextRole !== 'employee') setDepartment('all');
                        else if (department === 'all') setDepartment('admission');
                      }}
                      className="w-full px-3 py-2 text-sm border border-zinc-300 rounded-lg bg-white text-black disabled:bg-zinc-100 disabled:text-zinc-700 font-semibold focus:outline-none focus:ring-2 focus:ring-black"
                    >
                      <option value="employee">Department Employee</option>
                      {isSuperAdmin && <option value="centre_head">Centre Head</option>}
                    </select>
                  </div>

                  <div>
                    <label className="block text-xs font-bold text-black mb-1">
                      {role === 'centre_head' ? '2. Which Centre Is Head Assigned To?' : '2. Select Assigned Centre'}
                    </label>
                    <select
                      disabled={!isSuperAdmin}
                      value={isSuperAdmin ? centreId : currentUser.centreId}
                      onChange={(e) => setCentreId(e.target.value as CentreId)}
                      className="w-full px-3 py-2 text-sm border border-zinc-300 rounded-lg bg-white text-black disabled:bg-zinc-100 disabled:text-zinc-700 font-semibold focus:outline-none focus:ring-2 focus:ring-black"
                    >
                      {CANONICAL_CENTRES.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                {role === 'centre_head' ? (
                  <p className="text-[11px] text-black bg-amber-50 border border-amber-300 rounded-lg px-3 py-2">
                    Current Head at <strong>{CENTRE_MAP[centreId].name}</strong>:{' '}
                    {modalCentreHead
                      ? `${modalCentreHead.fullName} (${modalCentreHead.email})`
                      : modalPendingHead
                        ? `${modalPendingHead.fullName} (Pending Login)`
                        : 'Unassigned'}
                    . This Centre Head will only view {CENTRE_MAP[centreId].code} records.
                  </p>
                ) : (
                  <div>
                    <label className="block text-xs font-bold text-black mb-1">
                      3. Select Assigned Department (Strict Single-Department Access)
                    </label>
                    <select
                      value={department === 'all' ? 'admission' : department}
                      onChange={(e) => setDepartment(e.target.value as UserDepartment)}
                      className="w-full px-3 py-2 text-sm border border-zinc-300 rounded-lg bg-white text-black font-semibold focus:outline-none focus:ring-2 focus:ring-black"
                    >
                      {DEPARTMENTS.map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.label}
                        </option>
                      ))}
                    </select>
                    <p className="text-[11px] text-zinc-700 mt-1.5">
                      Access Scope: Only <strong>{DEPARTMENT_LABELS[department === 'all' ? 'admission' : department]}</strong> at{' '}
                      <strong>{CENTRE_MAP[isSuperAdmin ? centreId : currentUser.centreId].name}</strong> + Work Reports.
                    </p>
                  </div>
                )}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-black mb-1">Full Name</label>
                  <input
                    type="text"
                    required
                    value={fullName}
                    onChange={(e) => setFullName(e.target.value)}
                    placeholder="e.g. Abdul Sir"
                    className="w-full px-3 py-2 text-sm bg-white text-black placeholder:text-zinc-500 border border-zinc-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-black"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-black mb-1">Mobile Number</label>
                  <input
                    type="tel"
                    required
                    value={mobileNumber}
                    onChange={(e) => setMobileNumber(e.target.value)}
                    placeholder="9555XXXXXX"
                    className="w-full px-3 py-2 text-sm font-mono bg-white text-black placeholder:text-zinc-500 border border-zinc-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-black"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-black mb-1">Email Address</label>
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="staff@gmail.com"
                  className="w-full px-3 py-2 text-sm bg-white text-black placeholder:text-zinc-500 border border-zinc-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-black"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-black mb-1">Initial Password (min 6 chars)</label>
                  <input
                    type="password"
                    required
                    minLength={6}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="w-full px-3 py-2 text-sm bg-white text-black border border-zinc-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-black"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-black mb-1">Joining Date</label>
                  <input
                    type="date"
                    required
                    value={joiningDate}
                    onChange={(e) => setJoiningDate(e.target.value)}
                    className="w-full px-3 py-2 text-sm font-mono bg-white text-black border border-zinc-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-black"
                  />
                </div>
              </div>

              <div className="p-3 rounded-lg glass-dark-panel text-sky-100 text-[11px] leading-relaxed border border-sky-400/25">
                On login, this user just needs to select <strong className="text-[#F59E0B]">{CENTRE_MAP[isSuperAdmin ? centreId : currentUser.centreId].name}</strong> in Select Centre and enter this <strong className="text-white">Email ID &amp; Password</strong> directly (no email verification needed).
              </div>

              <div className="flex justify-end gap-2.5 pt-2 border-t border-slate-200">
                <button
                  type="button"
                  onClick={() => setShowCreateModal(false)}
                  className="px-4 py-2 text-xs font-semibold text-slate-800 bg-white hover:bg-slate-100 border border-slate-300 rounded-lg"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={busy}
                  className="px-4 py-2 text-xs font-bold text-white btn-crimson-gloss rounded-lg disabled:opacity-50"
                >
                  {busy ? 'Provisioning...' : 'Create Account'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Edit User Modal */}
      {editingUser && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#090d1b]/75 backdrop-blur-md p-4">
          <div className="glass-light-card rounded-2xl border border-slate-200 shadow-2xl max-w-md w-full p-6 text-slate-900">
            <div className="flex items-start justify-between pb-3 border-b border-zinc-200">
              <div>
                <h3 className="text-base font-bold text-black">Edit Staff Permissions</h3>
                <p className="text-xs text-zinc-700 mt-0.5">{editingUser.email}</p>
              </div>
              <button type="button" onClick={() => setEditingUser(null)} className="text-zinc-600 hover:text-black">
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSaveEdit} className="mt-4 space-y-3.5">
              <div>
                <label className="block text-xs font-semibold text-black mb-1">Full Name</label>
                <input
                  type="text"
                  required
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  className="w-full px-3 py-2 text-sm bg-white text-black border border-zinc-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-black"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-black mb-1">Mobile Number</label>
                <input
                  type="tel"
                  value={editMobile}
                  onChange={(e) => setEditMobile(e.target.value)}
                  className="w-full px-3 py-2 text-sm font-mono bg-white text-black border border-zinc-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-black"
                />
              </div>
              {isSuperAdmin && editingUser.role !== 'super_admin' && (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-semibold text-black mb-1">Role</label>
                    <select
                      value={editRole}
                      onChange={(e) => setEditRole(e.target.value as UserRole)}
                      className="w-full px-3 py-2 text-sm bg-white text-black border border-zinc-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-black"
                    >
                      <option value="employee">Employee</option>
                      <option value="centre_head">Centre Head</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-black mb-1">Assigned Centre</label>
                    <select
                      value={editCentre}
                      onChange={(e) => setEditCentre(e.target.value as CentreId)}
                      className="w-full px-3 py-2 text-sm bg-white text-black border border-zinc-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-black"
                    >
                      {CANONICAL_CENTRES.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              )}

              {editRole === 'employee' && (
                <div>
                  <label className="block text-xs font-semibold text-black mb-1">Department</label>
                  <select
                    value={editDept === 'all' ? 'admission' : editDept}
                    onChange={(e) => setEditDept(e.target.value as UserDepartment)}
                    className="w-full px-3 py-2 text-sm bg-white text-black border border-zinc-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-black"
                  >
                    {DEPARTMENTS.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.label}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <div>
                <label className="block text-xs font-semibold text-black mb-1">Account Status</label>
                <select
                  value={editStatus}
                  onChange={(e) => setEditStatus(e.target.value as AccountStatus)}
                  className="w-full px-3 py-2 text-sm bg-white text-black border border-zinc-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-black"
                >
                  <option value="Active">Active</option>
                  <option value="Inactive">Inactive</option>
                </select>
              </div>

              <div className="flex justify-end gap-2.5 pt-2">
                <button
                  type="button"
                  onClick={() => setEditingUser(null)}
                  className="px-4 py-2 text-xs font-semibold text-black bg-white hover:bg-zinc-100 border border-zinc-300 rounded-lg"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={busy}
                  className="px-4 py-2 text-xs font-bold text-white btn-crimson-gloss rounded-lg disabled:opacity-50"
                >
                  {busy ? 'Saving...' : 'Update Staff Member'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      <DeleteProtectionModal
        open={Boolean(deleteTargetUser)}
        title={deleteTargetUser ? `Remove ${deleteTargetUser.fullName}?` : 'Remove Staff Member'}
        description={
          deleteTargetUser
            ? `Kya aap ${deleteTargetUser.fullName} (${deleteTargetUser.email}) — ${ROLE_LABELS[deleteTargetUser.role]} (${deleteTargetUser.centreName}) ko permanently hatana chahte hain? Unka portal login access turant band ho jayega.`
            : ''
        }
        confirmLabel="Verify & Delete Staff"
        busy={deletingStaff}
        onConfirm={handleConfirmDeleteStaff}
        onCancel={() => setDeleteTargetUser(null)}
      />
    </div>
  );
};
