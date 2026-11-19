import { doc } from 'firebase/firestore';
import firebaseConfig from '../../firebase-applet-config.json';
import { CANONICAL_CENTRES, isBootstrappedOwnerEmail } from '../constants/centres';
import { auth, db } from './firebase';
import { CACHE_TTL_MS, fetchDocumentCached } from './firestoreCache';
import type { CentreId, UserAccount, UserDepartment, UserRole } from '../types/domain';

export interface LocationVerificationResult {
  allowed: boolean;
  verificationId?: string;
  distanceMeters?: number;
  radiusMeters?: number;
  overrideApplied?: boolean;
  locationProofToken?: string;
  error?: string;
}

function getCurrentPositionAsync(timeoutMs = 12000): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('Browser geolocation is not supported on this device.'));
      return;
    }
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: timeoutMs >= 5000,
      timeout: timeoutMs,
      maximumAge: timeoutMs < 5000 ? 60000 : 0,
    });
  });
}

function haversineMetersClient(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const R = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

function isJsonResponse(res: Response): boolean {
  const ct = (res.headers.get('content-type') || '').toLowerCase();
  return ct.includes('application/json');
}

export function mapFirebaseAuthErrorMessage(rawCode: string): string {
  switch (rawCode) {
    case 'INVALID_EMAIL':
      return 'Please enter a valid Email Address.';
    case 'WEAK_PASSWORD':
    case 'WEAK_PASSWORD : Password should be at least 6 characters':
      return 'Password must be at least 6 characters long.';
    case 'TOO_MANY_ATTEMPTS_TRY_LATER':
      return 'Too many attempts. Please wait a minute and try again.';
    default:
      return rawCode || 'Failed to provision authentication user.';
  }
}

export async function verifyOperationLocation(
  userProfile: UserAccount,
  operation: string,
  targetCentreId?: CentreId,
): Promise<LocationVerificationResult> {
  const currentUser = auth.currentUser;
  if (!currentUser) {
    return { allowed: false, error: 'Authentication session expired. Please sign in again.' };
  }

  const idToken = await currentUser.getIdToken(true);
  const centreId = targetCentreId || userProfile.centreId;

  let challengeToken = '';
  let backendAvailable = false;

  // Step 1: Request single-use anti-replay challenge from server (if Express backend is mounted)
  try {
    const challengeRes = await fetch('/api/security/location-challenge', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${idToken}`,
      },
      body: JSON.stringify({ centreId }),
    });

    if (challengeRes.status !== 404 && challengeRes.status !== 405 && isJsonResponse(challengeRes)) {
      backendAvailable = true;
      if (!challengeRes.ok) {
        const errBody = await challengeRes.json().catch(() => ({}));
        return { allowed: false, error: errBody.error || 'Failed to initiate location security challenge.' };
      }
      const parsed = (await challengeRes.json()) as { challengeToken: string };
      challengeToken = parsed.challengeToken;
    }
  } catch {
    backendAvailable = false;
  }

  // Fallback for static hosting (e.g., Netlify) where /api/* Express routes are not deployed
  if (!backendAvailable) {
    if (userProfile.role === 'super_admin') {
      return { allowed: true, overrideApplied: true };
    }
    try {
      const [settingsDataRaw, centreDataRaw] = await Promise.all([
        fetchDocumentCached<Record<string, unknown>>(
          'system_settings',
          'global',
          doc(db, 'system_settings', 'global'),
          CACHE_TTL_MS.STATIC,
        ).catch(() => null),
        fetchDocumentCached<Record<string, unknown>>(
          'centres',
          centreId,
          doc(db, 'centres', centreId),
          CACHE_TTL_MS.STATIC,
        ).catch(() => null),
      ]);
      const settingsData = settingsDataRaw || {};
      if (settingsData.geofenceEnabled === false || settingsData.emergencyOverrideActive === true) {
        return { allowed: true, overrideApplied: true };
      }
      const pos = await getCurrentPositionAsync(12000);
      const fallbackCentre = CANONICAL_CENTRES.find((c) => c.id === centreId) || CANONICAL_CENTRES[0];
      const centreData = centreDataRaw || fallbackCentre;
      const distanceMeters = haversineMetersClient(
        pos.coords.latitude,
        pos.coords.longitude,
        Number(centreData.latitude ?? fallbackCentre.latitude),
        Number(centreData.longitude ?? fallbackCentre.longitude),
      );
      const radiusMeters = Number(centreData.geofenceRadiusMeters ?? 300);
      if (distanceMeters > radiusMeters) {
        return {
          allowed: false,
          distanceMeters,
          radiusMeters,
          error: 'ACCESS DENIED: You must be physically present at your assigned centre to perform this operation.',
        };
      }
      return { allowed: true, distanceMeters, radiusMeters, overrideApplied: false };
    } catch (geoErr) {
      const geoMessage =
        geoErr instanceof GeolocationPositionError && geoErr.code === geoErr.PERMISSION_DENIED
          ? 'ACCESS DENIED: Location permission is required. You must be physically present at your assigned centre to perform this operation.'
          : 'ACCESS DENIED: Unable to verify GPS coordinates. Ensure location services are enabled at your assigned centre.';
      return { allowed: false, error: geoMessage };
    }
  }

  // Step 2: Capture GPS coordinates (Super Admin still logs quick cached location if available, without stalling)
  let latitude = 0;
  let longitude = 0;
  let accuracy = 0;
  let clientTimestamp = Date.now();

  try {
    const pos = await getCurrentPositionAsync(userProfile.role === 'super_admin' ? 1200 : 12000);
    latitude = pos.coords.latitude;
    longitude = pos.coords.longitude;
    accuracy = pos.coords.accuracy;
    clientTimestamp = pos.timestamp || Date.now();
  } catch (geoErr) {
    if (userProfile.role !== 'super_admin') {
      const geoMessage =
        geoErr instanceof GeolocationPositionError && geoErr.code === geoErr.PERMISSION_DENIED
          ? 'ACCESS DENIED: Location permission is required. You must be physically present at your assigned centre to perform this operation.'
          : 'ACCESS DENIED: Unable to verify GPS coordinates. Ensure location services are enabled at your assigned centre.';
      return { allowed: false, error: geoMessage };
    }
  }

  // Step 3: Server-side Haversine + accuracy + anti-replay verification
  const verifyRes = await fetch('/api/security/verify-location', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${idToken}`,
    },
    body: JSON.stringify({
      challengeToken,
      latitude,
      longitude,
      accuracy,
      clientTimestamp,
      operation,
      targetCentreId: centreId,
    }),
  });

  const data = (await verifyRes.json().catch(() => ({}))) as LocationVerificationResult;
  if (!verifyRes.ok || !data.allowed) {
    return {
      allowed: false,
      distanceMeters: data.distanceMeters,
      radiusMeters: data.radiusMeters,
      error:
        data.error ||
        'ACCESS DENIED: You must be physically present at your assigned centre to perform this operation.',
    };
  }

  return data;
}

export async function verifySuperAdminOwnerOnServer(authorizedEmail: string): Promise<{
  allowed: boolean;
  error?: string;
}> {
  const currentUser = auth.currentUser;
  if (!currentUser) return { allowed: false, error: 'Not authenticated.' };
  try {
    const idToken = await currentUser.getIdToken(true);
    const res = await fetch('/api/setup/verify-owner', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${idToken}`,
      },
      body: JSON.stringify({ authorizedEmail }),
    });
    if (res.status === 404 || res.status === 405 || !isJsonResponse(res)) {
      return { allowed: isBootstrappedOwnerEmail(authorizedEmail) };
    }
    const body = (await res.json().catch(() => ({}))) as { allowed?: boolean; error?: string };
    return { allowed: Boolean(res.ok && body.allowed), error: body.error };
  } catch {
    return { allowed: isBootstrappedOwnerEmail(authorizedEmail) };
  }
}

export type ProvisionUserResult =
  | { mode: 'auth_created'; uid: string; email: string; verificationSent: boolean }
  | { mode: 'invite_fallback'; reason?: 'provider_disabled' | 'email_exists' };

async function provisionViaFirebaseIdentityToolkit(params: {
  email: string;
  password: string;
  fullName: string;
}): Promise<ProvisionUserResult> {
  const signUpRes = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${encodeURIComponent(firebaseConfig.apiKey)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: params.email.trim(),
        password: params.password,
        displayName: params.fullName.trim(),
        returnSecureToken: true,
      }),
    },
  );
  const signUpData = (await signUpRes.json().catch(() => ({}))) as {
    localId?: string;
    email?: string;
    error?: { message?: string };
  };

  if (signUpRes.ok && signUpData.localId) {
    return {
      mode: 'auth_created',
      uid: signUpData.localId,
      email: signUpData.email || params.email.trim(),
      verificationSent: false,
    };
  }

  const msg = signUpData.error?.message || '';
  if (msg === 'OPERATION_NOT_ALLOWED' || msg === 'PASSWORD_LOGIN_DISABLED') {
    return { mode: 'invite_fallback', reason: 'provider_disabled' };
  }
  if (msg === 'EMAIL_EXISTS') {
    return { mode: 'invite_fallback', reason: 'email_exists' };
  }
  throw new Error(mapFirebaseAuthErrorMessage(msg));
}

export async function provisionAuthUserOnServer(params: {
  email: string;
  password: string;
  fullName: string;
  role: UserRole;
  centreId: CentreId;
  department: UserDepartment;
}): Promise<ProvisionUserResult> {
  const currentUser = auth.currentUser;
  if (!currentUser) throw new Error('Not authenticated.');

  const idToken = await currentUser.getIdToken(true);
  try {
    const res = await fetch('/api/users/provision', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${idToken}`,
      },
      body: JSON.stringify(params),
    });

    // If deployed on static host (e.g., Netlify) where Express /api/users/provision isn't mounted,
    // call Firebase Identity Toolkit REST directly so Super Admin session stays active without sign-out.
    if (res.status === 404 || res.status === 405 || !isJsonResponse(res)) {
      return await provisionViaFirebaseIdentityToolkit(params);
    }

    const body = (await res.json().catch(() => ({}))) as {
      uid?: string;
      email?: string;
      verificationSent?: boolean;
      providerDisabled?: boolean;
      emailExists?: boolean;
      code?: string;
      error?: string;
    };

    if (body.providerDisabled || body.code === 'OPERATION_NOT_ALLOWED' || body.code === 'PASSWORD_LOGIN_DISABLED') {
      return { mode: 'invite_fallback', reason: 'provider_disabled' };
    }
    if (body.emailExists || body.code === 'EMAIL_EXISTS') {
      return { mode: 'invite_fallback', reason: 'email_exists' };
    }
    if (!res.ok || !body.uid) {
      throw new Error(mapFirebaseAuthErrorMessage(body.error || 'Failed to provision authentication user.'));
    }
    return {
      mode: 'auth_created',
      uid: body.uid,
      email: body.email || params.email,
      verificationSent: Boolean(body.verificationSent),
    };
  } catch (err) {
    // Only fall back to direct Identity Toolkit if fetch/network failed (not validation/permission errors)
    if (err instanceof TypeError) {
      return await provisionViaFirebaseIdentityToolkit(params);
    }
    throw err;
  }
}
