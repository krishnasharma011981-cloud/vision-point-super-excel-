# Security Specification — VISION POINT SUPER EXCEL

## 1. Data Invariants
1. **Strict Centre Isolation**: Every student, department record, employee assignment, and activity log belongs to a single canonical `centreId` (`vp_lookerganj`, `vp_civillines`, `xis_varanasi`, `xis_jaunpur`). Centre Heads and Employees can never read or mutate records outside their assigned `centreId`.
2. **Strict Department Isolation**: Department Employees have exactly one assigned `department` (`fee_recovery`, `practical`, `tma`, `online_classes`, `admission`). An employee in one department cannot read or write department-specific collections of the other four departments.
3. **Single Source of Truth for Students**: Central student profiles live exclusively in `/students/{studentId}`. Department collections (`/fee_recovery`, `/practical_records`, `/tma_records`, `/online_class_records`, `/admission_records`) reference the existing `studentId` (verified via `exists()` on create) and never duplicate core student profiles.
4. **Role Escalation Prevention**: Only an active, email-verified Super Admin can create or assign Centre Heads or elevate roles. Centre Heads can only provision `employee` accounts within their own `centreId`. Users cannot modify their own `role`, `centreId`, `department`, or `status`.
5. **Temporal & Audit Integrity**: All `createdAt` and `updatedAt` timestamps must match `request.time`. `createdAt`, `createdBy`, `studentId`, and `serialNumber` are immutable after creation. `activity_logs` and `location_verifications` are strictly append-only (no updates or deletes).
6. **Physical Presence Geofencing**: Non-Super Admin restricted mutations are gated through `/api/security/location-challenge` (single-use HMAC nonce) and `/api/security/verify-location` (server-side Haversine distance against centre GPS coordinates, accuracy threshold `<= 500m`, timestamp freshness `±120s`, anti-replay nonce consumption).

## 2. The "Dirty Dozen" Adversarial Payloads
1. **Unverified Admin Email Spoof**: User signs up with `krishnasharma011981@gmail.com` with `email_verified: false` and attempts to write to `/system_settings/global` -> MUST return `PERMISSION_DENIED`.
2. **Self-Role Escalation on User Create**: Employee attempts `create` on `/users/{uid}` with `role: "super_admin"` -> MUST return `PERMISSION_DENIED`.
3. **Self-Role Escalation on User Update**: Centre Head updates their own `/users/{uid}` changing `role` to `"super_admin"` or `centreId` to `"vp_lookerganj"` -> MUST return `PERMISSION_DENIED`.
4. **Cross-Centre Student Read**: Centre Head of `vp_civillines` queries `/students` with `centreId == "xis_varanasi"` -> MUST return `PERMISSION_DENIED`.
5. **Cross-Department Write**: `fee_recovery` employee attempts `setDoc` on `/practical_records/{studentId}` -> MUST return `PERMISSION_DENIED`.
6. **Cross-Department Read**: `tma` employee attempts `getDoc` on `/fee_recovery/{studentId}` -> MUST return `PERMISSION_DENIED`.
7. **Shadow Ghost Field Injection**: Authorized user updates `/students/{studentId}` adding an undeclared `isAdminVerified: true` field -> MUST return `PERMISSION_DENIED`.
8. **Orphaned Department Record**: Authorized employee creates `/tma_records/FAKE_ID` where `/students/FAKE_ID` does not exist -> MUST return `PERMISSION_DENIED`.
9. **ID Poisoning / 1MB String Exhaustion**: Attacker creates `/students/{1500_char_id}` or injects a 50KB `additionalRemarks` string -> MUST return `PERMISSION_DENIED`.
10. **Client Timestamp Forgery**: User submits `createdAt` backdated to 2020 instead of `serverTimestamp()` -> MUST return `PERMISSION_DENIED`.
11. **Audit Log Tampering**: Centre Head attempts `updateDoc` or `deleteDoc` on `/activity_logs/{logId}` -> MUST return `PERMISSION_DENIED`.
12. **Deactivated Account Access**: Employee with `status: "Inactive"` attempts to read `/fee_recovery/{studentId}` -> MUST return `PERMISSION_DENIED`.
