import { ShieldAlert, X } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import { CANONICAL_CENTRES, CENTRE_MAP, DEPARTMENT_LABELS } from '../constants/centres';
import { clampFeeNumber, maskMobileNumber } from '../lib/analyticsMath';
import { verifyOperationLocation } from '../lib/securityClient';
import {
  checkDuplicateStudent,
  createStudentRecord,
  getNextSerialNumber,
  isStudentDeptLockedForEmployee,
  updateStudentRecord,
} from '../services/firestoreService';
import type {
  BookStatus,
  CentreId,
  ClassAttendanceStatus,
  ExaminationStatus,
  PracticalStatus,
  Student,
  TcStatus,
  TmaStatus,
  UserAccount,
} from '../types/domain';

interface StudentFormModalProps {
  open: boolean;
  editingStudent: Student | null;
  currentUser: UserAccount;
  defaultCentreId: CentreId;
  existingStudents: Student[];
  employees: UserAccount[];
  onClose: () => void;
  onSuccess: (message: string) => void;
  onError: (title: string, description: string) => void;
}

export const StudentFormModal: React.FC<StudentFormModalProps> = ({
  open,
  editingStudent,
  currentUser,
  defaultCentreId,
  existingStudents,
  employees,
  onClose,
  onSuccess,
  onError,
}) => {
  const isEditing = Boolean(editingStudent);

  const [centreId, setCentreId] = useState<CentreId>(defaultCentreId);
  const [studentId, setStudentId] = useState('');
  const [studentName, setStudentName] = useState('');
  const [mobileNumber, setMobileNumber] = useState('');
  const [subject, setSubject] = useState('');
  const [tcStatus, setTcStatus] = useState<TcStatus>('Not Received');
  const [bookStatus, setBookStatus] = useState<BookStatus>('Pending');
  const [classAttendanceStatus, setClassAttendanceStatus] = useState<ClassAttendanceStatus>('Not Attending');
  const [whyNios, setWhyNios] = useState('');
  const [currentEducationStatus, setCurrentEducationStatus] = useState('');
  const [futurePlanning, setFuturePlanning] = useState('');
  const [tmaStatus, setTmaStatus] = useState<TmaStatus>('Pending');
  const [practicalStatus, setPracticalStatus] = useState<PracticalStatus>('Pending');
  const [examinationStatus, setExaminationStatus] = useState<ExaminationStatus>('Not Completed');
  const [admissionDate, setAdmissionDate] = useState(new Date().toISOString().slice(0, 10));
  const [assignedEmployeeUid, setAssignedEmployeeUid] = useState('');
  const [additionalRemarks, setAdditionalRemarks] = useState('');
  const [totalFee, setTotalFee] = useState('12000');
  const [paidAmount, setPaidAmount] = useState('5000');
  const [tmaFee, setTmaFee] = useState('0');
  const [examFee, setExamFee] = useState('0');

  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setFormError(null);
    if (editingStudent) {
      setCentreId(editingStudent.centreId);
      setStudentId(editingStudent.studentId);
      setStudentName(editingStudent.studentName);
      setMobileNumber('');
      setSubject(editingStudent.subject);
      setTcStatus(editingStudent.tcStatus);
      setBookStatus(editingStudent.bookStatus);
      setClassAttendanceStatus(editingStudent.classAttendanceStatus);
      setWhyNios(editingStudent.whyNios);
      setCurrentEducationStatus(editingStudent.currentEducationStatus);
      setFuturePlanning(editingStudent.futurePlanning);
      setTmaStatus(editingStudent.tmaStatus);
      setPracticalStatus(editingStudent.practicalStatus);
      setExaminationStatus(editingStudent.examinationStatus);
      setAdmissionDate(editingStudent.admissionDate);
      setAssignedEmployeeUid(editingStudent.assignedEmployeeUid);
      setAdditionalRemarks(editingStudent.additionalRemarks);
      setTmaFee(String(editingStudent.tmaFee ?? 0));
      setExamFee(String(editingStudent.examFee ?? 0));
    } else {
      const targetCentre = currentUser.role === 'super_admin' ? defaultCentreId : currentUser.centreId;
      setCentreId(targetCentre);
      const code = CENTRE_MAP[targetCentre].code;
      const nextNum = existingStudents.length + 1;
      setStudentId(`${code}-${new Date().getFullYear()}-${String(nextNum).padStart(4, '0')}`);
      setStudentName('');
      setMobileNumber('');
      setSubject('Hindi, English, Mathematics, Science, Social Science');
      setTcStatus('Not Received');
      setBookStatus('Pending');
      setClassAttendanceStatus('Not Attending');
      setWhyNios('');
      setCurrentEducationStatus('');
      setFuturePlanning('');
      setTmaStatus('Pending');
      setPracticalStatus('Pending');
      setExaminationStatus('Not Completed');
      setAdmissionDate(new Date().toISOString().slice(0, 10));
      setAssignedEmployeeUid(currentUser.role === 'employee' ? currentUser.uid : '');
      setAdditionalRemarks('');
      setTotalFee('12000');
      setPaidAmount('5000');
      setTmaFee('0');
      setExamFee('0');
    }
  }, [open, editingStudent, defaultCentreId, currentUser, existingStudents.length]);

  if (!open) return null;

  const centreEmployees = employees.filter((e) => e.centreId === centreId && e.status === 'Active');
  const isEmployee = currentUser.role === 'employee';
  const empDept = currentUser.department;
  const isDeptLockedForActor = Boolean(
    isEditing && editingStudent && isEmployee && isStudentDeptLockedForEmployee(editingStudent, empDept),
  );

  const canEditAdmissionFields = !isEmployee || (empDept === 'admission' && !isDeptLockedForActor);
  const canEditTmaField = !isEmployee || (Boolean(isEditing) && empDept === 'tma' && !isDeptLockedForActor);
  const canEditPracticalField =
    !isEmployee || (Boolean(isEditing) && empDept === 'practical' && !isDeptLockedForActor);
  const canEditOnlineClassField =
    !isEmployee || (Boolean(isEditing) && empDept === 'online_classes' && !isDeptLockedForActor);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);

    const effectiveMobile =
      isEditing && editingStudent && mobileNumber.trim() === ''
        ? editingStudent.mobileNumber
        : mobileNumber.trim();

    if (studentName.trim().length < 2 || effectiveMobile.length < 7) {
      setFormError('Valid Student Name and Mobile Number are required.');
      return;
    }

    setSaving(true);
    try {
      const serialNumber = await getNextSerialNumber(existingStudents);
      const cleanId = isEditing && editingStudent
        ? editingStudent.studentId
        : `${CENTRE_MAP[centreId].code}-${new Date().getFullYear()}-${String(serialNumber).padStart(4, '0')}-${Math.random()
            .toString(36)
            .slice(2, 5)
            .toUpperCase()}`;

      if (isEditing && editingStudent) {
        if (isEmployee && isStudentDeptLockedForEmployee(editingStudent, empDept)) {
          setFormError(
            `${DEPARTMENT_LABELS[empDept] || empDept} entry is locked after saving. Ask permission from your Centre Head to unlock 1 correction edit.`,
          );
          setSaving(false);
          return;
        }
        if (currentUser.role === 'centre_head' && editingStudent.centreId !== currentUser.centreId) {
          setFormError('Centre Head can only edit student records belonging to their own centre.');
          setSaving(false);
          return;
        }
      }

      if (!isEditing && isEmployee && empDept !== 'admission') {
        setFormError('Only Admission department employees, Centre Head, or Super Admin can add new students.');
        setSaving(false);
        return;
      }

      // 1. Duplicate check on create
      if (!isEditing) {
        const dupMsg = await checkDuplicateStudent(cleanId, mobileNumber, centreId);
        if (dupMsg) {
          setFormError(dupMsg);
          setSaving(false);
          return;
        }
      }

      // 2. Server-side Location Verification (enforced for Centre Head & Employees)
      const locCheck = await verifyOperationLocation(
        currentUser,
        isEditing ? `EDIT_STUDENT:${cleanId}` : `CREATE_STUDENT:${cleanId}`,
        centreId,
      );
      if (!locCheck.allowed) {
        setFormError(
          locCheck.error ||
            'ACCESS DENIED: You must be physically present at your assigned centre to perform this operation.',
        );
        onError('Location Verification Failed', locCheck.error || 'Outside authorized centre geofence.');
        setSaving(false);
        return;
      }

      const assignedEmp = employees.find((emp) => emp.uid === assignedEmployeeUid);
      const assignedEmpName =
        assignedEmp?.fullName || (assignedEmployeeUid === currentUser.uid ? currentUser.fullName : 'Unassigned');

      const cleanTmaFee = clampFeeNumber(tmaFee);
      const cleanExamFee = clampFeeNumber(examFee);

      if (isEditing && editingStudent) {
        let updatesPayload: Partial<Student> = {
          studentName: studentName.trim(),
          mobileNumber: effectiveMobile,
          subject: subject.trim(),
          tcStatus,
          bookStatus,
          classAttendanceStatus,
          whyNios: whyNios.trim(),
          currentEducationStatus: currentEducationStatus.trim(),
          futurePlanning: futurePlanning.trim(),
          tmaStatus,
          practicalStatus,
          examinationStatus,
          admissionDate,
          assignedEmployeeUid,
          assignedEmployeeName: assignedEmpName,
          additionalRemarks: additionalRemarks.trim(),
          tmaFee: cleanTmaFee,
          examFee: cleanExamFee,
        };

        if (isEmployee) {
          if (empDept === 'tma') {
            updatesPayload = { tmaStatus };
          } else if (empDept === 'practical') {
            updatesPayload = { practicalStatus };
          } else if (empDept === 'online_classes') {
            updatesPayload = { classAttendanceStatus };
          } else if (empDept === 'admission') {
            updatesPayload = {
              studentName: studentName.trim(),
              mobileNumber: effectiveMobile,
              subject: subject.trim(),
              tcStatus,
              bookStatus,
              whyNios: whyNios.trim(),
              currentEducationStatus: currentEducationStatus.trim(),
              futurePlanning: futurePlanning.trim(),
              examinationStatus,
              admissionDate,
              assignedEmployeeUid,
              assignedEmployeeName: assignedEmpName,
              additionalRemarks: additionalRemarks.trim(),
              tmaFee: cleanTmaFee,
              examFee: cleanExamFee,
            };
          } else {
            setFormError('Your department has read-only access on central student rows.');
            setSaving(false);
            return;
          }
        }

        await updateStudentRecord(
          editingStudent.studentId,
          updatesPayload,
          currentUser,
          editingStudent.centreId,
          true,
        );
        onSuccess(
          isEmployee
            ? `Saved & locked ${DEPARTMENT_LABELS[empDept] || empDept} update for ${studentName.trim()} (#${editingStudent.serialNumber}).`
            : `Updated Excel record #${editingStudent.serialNumber} for ${studentName.trim()}.`,
        );
      } else {
        await createStudentRecord(
          {
            serialNumber,
            studentId: cleanId,
            studentName: studentName.trim(),
            mobileNumber: mobileNumber.trim(),
            subject: subject.trim(),
            tcStatus,
            bookStatus,
            classAttendanceStatus,
            whyNios: whyNios.trim(),
            currentEducationStatus: currentEducationStatus.trim(),
            futurePlanning: futurePlanning.trim(),
            tmaStatus,
            practicalStatus,
            examinationStatus,
            centreId,
            centreName: CENTRE_MAP[centreId].name,
            admissionDate,
            assignedEmployeeUid,
            assignedEmployeeName: assignedEmpName,
            additionalRemarks: additionalRemarks.trim(),
            tmaFee: cleanTmaFee,
            examFee: cleanExamFee,
          },
          currentUser,
          true,
          {
            totalFee: Number(totalFee) || 12000,
            paidAmount: Number(paidAmount) || 0,
            tmaFee: cleanTmaFee,
            examFee: cleanExamFee,
            createDepartmentSkeletons: currentUser.role !== 'employee',
          },
        );
        onSuccess(`Added student ${studentName.trim()} at Serial #${serialNumber}.`);
      }
      onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to save student record.';
      setFormError(msg);
      onError('Database Save Error', msg);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#090d1b]/75 backdrop-blur-sm p-4 overflow-y-auto">
      <div className="bg-white/95 backdrop-blur-xl rounded-2xl border border-slate-200 shadow-2xl max-w-4xl w-full my-8 overflow-hidden text-[#0F172A]">
        <div className="px-6 py-4 glass-dark-panel border-b border-rose-400/20 flex items-center justify-between text-white">
          <div>
            <h2 className="text-lg font-bold text-white">
              {isEditing ? `Edit Student — Serial #${editingStudent?.serialNumber}` : 'Register New Student in Excel'}
            </h2>
            <p className="text-xs text-slate-200/85 mt-0.5">
              Central Student Database · {currentUser.role === 'employee' ? 'Row locks automatically once filled' : 'Multi-centre governance'}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-sky-100 hover:text-white p-1.5 rounded-lg"
            aria-label="Close form"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-5 max-h-[78vh] overflow-y-auto">
          {isEmployee && (
            <div className="p-3.5 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-950">
              <strong>Department Isolation ({DEPARTMENT_LABELS[empDept] || empDept}):</strong> You can view all fields,
              but you can only edit and lock your own department&apos;s fields once. To correct a locked field later,
              use <strong>Ask Permission</strong> from your Centre Head.
            </div>
          )}

          {formError && (
            <div className="p-3.5 rounded-lg bg-red-50 border border-red-200 flex items-start gap-2.5 text-xs text-red-900">
              <ShieldAlert className="w-4 h-4 text-red-700 shrink-0 mt-0.5" />
              <span>{formError}</span>
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            <div>
              <label className="block text-xs font-semibold text-[#08152E] mb-1">Student Full Name</label>
              <input
                type="text"
                required
                disabled={!canEditAdmissionFields}
                value={studentName}
                onChange={(e) => setStudentName(e.target.value)}
                placeholder="e.g. Aarav Mishra"
                className="w-full px-3 py-2 text-sm bg-white text-[#08152E] placeholder:text-slate-400 border border-slate-300 rounded-lg disabled:bg-slate-100 disabled:text-slate-600 focus:outline-none focus:ring-2 focus:ring-[#0F2F6B]"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-[#08152E] mb-1">
                Mobile Number {isEditing && editingStudent ? `(${maskMobileNumber(editingStudent.mobileNumber)})` : ''}
              </label>
              <input
                type="tel"
                required={!isEditing}
                disabled={!canEditAdmissionFields}
                value={mobileNumber}
                onChange={(e) => setMobileNumber(e.target.value)}
                placeholder={
                  isEditing && editingStudent
                    ? `${maskMobileNumber(editingStudent.mobileNumber)} (Leave blank to keep)`
                    : '10-digit mobile number'
                }
                className="w-full px-3 py-2 text-sm font-mono bg-white text-[#08152E] placeholder:text-slate-400 border border-slate-300 rounded-lg disabled:bg-slate-100 disabled:text-slate-600 focus:outline-none focus:ring-2 focus:ring-[#0F2F6B]"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-[#08152E] mb-1">Centre Name</label>
              <select
                disabled={isEditing || currentUser.role !== 'super_admin'}
                value={centreId}
                onChange={(e) => setCentreId(e.target.value as CentreId)}
                className="w-full px-3 py-2 text-sm bg-white text-[#08152E] border border-slate-300 rounded-lg disabled:bg-slate-100 disabled:text-slate-600 focus:outline-none focus:ring-2 focus:ring-[#0F2F6B]"
              >
                {CANONICAL_CENTRES.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-semibold text-[#08152E] mb-1">Admission Date</label>
              <input
                type="date"
                required
                disabled={!canEditAdmissionFields}
                value={admissionDate}
                onChange={(e) => setAdmissionDate(e.target.value)}
                className="w-full px-3 py-2 text-sm font-mono bg-white text-[#08152E] border border-slate-300 rounded-lg disabled:bg-slate-100 disabled:text-slate-600 focus:outline-none focus:ring-2 focus:ring-[#0F2F6B]"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-[#08152E] mb-1">Assigned Employee</label>
              <select
                disabled={!canEditAdmissionFields}
                value={assignedEmployeeUid}
                onChange={(e) => setAssignedEmployeeUid(e.target.value)}
                className="w-full px-3 py-2 text-sm bg-white text-[#08152E] border border-slate-300 rounded-lg disabled:bg-slate-100 disabled:text-slate-600 focus:outline-none focus:ring-2 focus:ring-[#0F2F6B]"
              >
                <option value="">Unassigned</option>
                {centreEmployees.map((emp) => (
                  <option key={emp.uid} value={emp.uid}>
                    {emp.fullName} ({emp.department})
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-semibold text-[#08152E] mb-1">Serial Order Preview</label>
              <input
                type="text"
                disabled
                value={`#${isEditing && editingStudent ? editingStudent.serialNumber : existingStudents.length + 1}`}
                className="w-full px-3 py-2 text-sm font-mono bg-slate-100 text-[#B91C1C] font-bold border border-slate-300 rounded-lg"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-[#08152E] mb-1">Subjects</label>
            <input
              type="text"
              required
              disabled={!canEditAdmissionFields}
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="e.g. English, Physics, Chemistry, Mathematics, Computer Science"
              className="w-full px-3 py-2 text-sm bg-white text-[#08152E] placeholder:text-slate-400 border border-slate-300 rounded-lg disabled:bg-slate-100 disabled:text-slate-600 focus:outline-none focus:ring-2 focus:ring-[#0F2F6B]"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            <div>
              <label className="block text-xs font-semibold text-[#08152E] mb-1">TC Status</label>
              <select
                disabled={!canEditAdmissionFields}
                value={tcStatus}
                onChange={(e) => setTcStatus(e.target.value as TcStatus)}
                className="w-full px-3 py-2 text-sm bg-white text-[#08152E] border border-slate-300 rounded-lg disabled:bg-slate-100 disabled:text-slate-600 focus:outline-none focus:ring-2 focus:ring-[#0F2F6B]"
              >
                <option value="Received">Received</option>
                <option value="Not Received">Not Received</option>
                <option value="Not Applicable">Not Applicable</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-semibold text-[#08152E] mb-1">Book Status</label>
              <select
                disabled={!canEditAdmissionFields}
                value={bookStatus}
                onChange={(e) => setBookStatus(e.target.value as BookStatus)}
                className="w-full px-3 py-2 text-sm bg-white text-[#08152E] border border-slate-300 rounded-lg disabled:bg-slate-100 disabled:text-slate-600 focus:outline-none focus:ring-2 focus:ring-[#0F2F6B]"
              >
                <option value="Received">Received</option>
                <option value="Not Received">Not Received</option>
                <option value="Pending">Pending</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-semibold text-[#08152E] mb-1">Attendance (Live Classes)</label>
              <select
                disabled={!canEditOnlineClassField}
                value={classAttendanceStatus}
                onChange={(e) => setClassAttendanceStatus(e.target.value as ClassAttendanceStatus)}
                className="w-full px-3 py-2 text-sm bg-white text-[#08152E] border border-slate-300 rounded-lg disabled:bg-slate-100 disabled:text-slate-600 focus:outline-none focus:ring-2 focus:ring-[#0F2F6B]"
              >
                <option value="Regular">Regular</option>
                <option value="Irregular">Irregular</option>
                <option value="Not Attending">Not Attending</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-semibold text-[#08152E] mb-1">TMA Status</label>
              <select
                disabled={!canEditTmaField}
                value={tmaStatus}
                onChange={(e) => setTmaStatus(e.target.value as TmaStatus)}
                className="w-full px-3 py-2 text-sm bg-white text-[#08152E] border border-slate-300 rounded-lg disabled:bg-slate-100 disabled:text-slate-600 focus:outline-none focus:ring-2 focus:ring-[#0F2F6B]"
              >
                <option value="Submitted">Submitted</option>
                <option value="Not Submitted">Not Submitted</option>
                <option value="Pending">Pending</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-semibold text-[#08152E] mb-1">Practical Status</label>
              <select
                disabled={!canEditPracticalField}
                value={practicalStatus}
                onChange={(e) => setPracticalStatus(e.target.value as PracticalStatus)}
                className="w-full px-3 py-2 text-sm bg-white text-[#08152E] border border-slate-300 rounded-lg disabled:bg-slate-100 disabled:text-slate-600 focus:outline-none focus:ring-2 focus:ring-[#0F2F6B]"
              >
                <option value="Completed">Completed</option>
                <option value="Not Completed">Not Completed</option>
                <option value="Pending">Pending</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-semibold text-[#08152E] mb-1">Examination Status</label>
              <select
                disabled={!canEditAdmissionFields}
                value={examinationStatus}
                onChange={(e) => setExaminationStatus(e.target.value as ExaminationStatus)}
                className="w-full px-3 py-2 text-sm bg-white text-[#08152E] border border-slate-300 rounded-lg disabled:bg-slate-100 disabled:text-slate-600 focus:outline-none focus:ring-2 focus:ring-[#0F2F6B]"
              >
                <option value="Completed">Completed</option>
                <option value="Not Completed">Not Completed</option>
                <option value="Partially Completed">Partially Completed</option>
              </select>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 p-4 rounded-xl bg-slate-50 border border-slate-200">
            {!isEditing && currentUser.role !== 'employee' && (
              <>
                <div>
                  <label className="block text-xs font-semibold text-[#08152E] mb-1">Total Fee Schedule (INR)</label>
                  <input
                    type="number"
                    min={0}
                    value={totalFee}
                    onChange={(e) => setTotalFee(e.target.value)}
                    className="w-full px-3 py-2 text-sm font-mono bg-white text-[#08152E] border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#0F2F6B]"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-[#08152E] mb-1">Initial Paid Amount (INR)</label>
                  <input
                    type="number"
                    min={0}
                    value={paidAmount}
                    onChange={(e) => setPaidAmount(e.target.value)}
                    className="w-full px-3 py-2 text-sm font-mono bg-white text-[#08152E] border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#0F2F6B]"
                  />
                </div>
              </>
            )}
            <div>
              <label className="block text-xs font-semibold text-amber-900 mb-1">TMA Fee (INR)</label>
              <input
                type="number"
                min={0}
                disabled={!canEditAdmissionFields}
                value={tmaFee}
                onChange={(e) => setTmaFee(e.target.value)}
                className="w-full px-3 py-2 text-sm font-mono bg-white text-[#08152E] border border-amber-300 rounded-lg disabled:bg-slate-100 disabled:text-slate-600 focus:outline-none focus:ring-2 focus:ring-[#0F2F6B]"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-indigo-900 mb-1">Exam Fee (INR)</label>
              <input
                type="number"
                min={0}
                disabled={!canEditAdmissionFields}
                value={examFee}
                onChange={(e) => setExamFee(e.target.value)}
                className="w-full px-3 py-2 text-sm font-mono bg-white text-[#08152E] border border-indigo-300 rounded-lg disabled:bg-slate-100 disabled:text-slate-600 focus:outline-none focus:ring-2 focus:ring-[#0F2F6B]"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="block text-xs font-semibold text-[#08152E] mb-1">Why Admission in NIOS?</label>
              <textarea
                rows={3}
                disabled={!canEditAdmissionFields}
                value={whyNios}
                onChange={(e) => setWhyNios(e.target.value)}
                placeholder="Reason student chose NIOS..."
                className="w-full px-3 py-2 text-sm bg-white text-[#08152E] placeholder:text-slate-400 border border-slate-300 rounded-lg disabled:bg-slate-100 disabled:text-slate-600 focus:outline-none focus:ring-2 focus:ring-[#0F2F6B]"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-[#08152E] mb-1">Current Education Status</label>
              <textarea
                rows={3}
                disabled={!canEditAdmissionFields}
                value={currentEducationStatus}
                onChange={(e) => setCurrentEducationStatus(e.target.value)}
                placeholder="Qualification & academic progress..."
                className="w-full px-3 py-2 text-sm bg-white text-[#08152E] placeholder:text-slate-400 border border-slate-300 rounded-lg disabled:bg-slate-100 disabled:text-slate-600 focus:outline-none focus:ring-2 focus:ring-[#0F2F6B]"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-[#08152E] mb-1">Future Planning</label>
              <textarea
                rows={3}
                disabled={!canEditAdmissionFields}
                value={futurePlanning}
                onChange={(e) => setFuturePlanning(e.target.value)}
                placeholder="Target career or higher education goals..."
                className="w-full px-3 py-2 text-sm bg-white text-[#08152E] placeholder:text-slate-400 border border-slate-300 rounded-lg disabled:bg-slate-100 disabled:text-slate-600 focus:outline-none focus:ring-2 focus:ring-[#0F2F6B]"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-[#08152E] mb-1">Additional Remarks</label>
            <textarea
              rows={2}
              disabled={!canEditAdmissionFields}
              value={additionalRemarks}
              onChange={(e) => setAdditionalRemarks(e.target.value)}
              placeholder="Administrative notes or special instructions..."
              className="w-full px-3 py-2 text-sm bg-white text-[#08152E] placeholder:text-slate-400 border border-slate-300 rounded-lg disabled:bg-slate-100 disabled:text-slate-600 focus:outline-none focus:ring-2 focus:ring-[#0F2F6B]"
            />
          </div>

          <div className="pt-4 border-t border-slate-200 flex items-center justify-end gap-3">
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="px-4 py-2 text-sm font-medium text-[#08152E] bg-white border border-slate-300 rounded-lg hover:bg-slate-100"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving || isDeptLockedForActor}
              className="px-5 py-2 text-sm font-bold text-white btn-crimson-gloss rounded-lg disabled:opacity-50"
            >
              {saving
                ? 'Verifying Location & Saving...'
                : isEditing
                  ? isEmployee
                    ? 'Save & Lock Dept Entry'
                    : 'Save Student Changes'
                  : currentUser.role === 'employee'
                    ? 'Save & Lock Entry'
                    : 'Register Student'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
