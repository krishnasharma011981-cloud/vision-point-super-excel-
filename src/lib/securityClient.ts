import { auth } from './firebase';
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

  // Step 1: Request single-use anti-replay challenge from server
  const challengeRes = await fetch('/api/security/location-challenge', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${idToken}`,
    },
    body: JSON.stringify({ centreId }),
  });

  if (!challengeRes.ok) {
    const errBody = await challengeRes.json().catch(() => ({}));
    return { allowed: false, error: errBody.error || 'Failed to initiate location security challenge.' };
  }

  const { challengeToken } = (await challengeRes.json()) as { challengeToken: string };

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
  const idToken = await currentUser.getIdToken(true);
  const res = await fetch('/api/setup/verify-owner', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${idToken}`,
    },
    body: JSON.stringify({ authorizedEmail }),
  });
  const body = (await res.json().catch(() => ({}))) as { allowed?: boolean; error?: string };
  return { allowed: Boolean(res.ok && body.allowed), error: body.error };
}

export async function provisionAuthUserOnServer(params: {
  email: string;
  password: string;
  fullName: string;
  role: UserRole;
  centreId: CentreId;
  department: UserDepartment;
}): Promise<
  | { mode: 'auth_created'; uid: string; email: string; verificationSent: boolean }
  | { mode: 'invite_fallback' }
> {
  const currentUser = auth.currentUser;
  if (!currentUser) throw new Error('Not authenticated.');
  const idToken = await currentUser.getIdToken(true);
  const res = await fetch('/api/users/provision', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${idToken}`,
    },
    body: JSON.stringify(params),
  });
  const body = (await res.json().catch(() => ({}))) as {
    uid?: string;
    email?: string;
    verificationSent?: boolean;
    providerDisabled?: boolean;
    code?: string;
    error?: string;
  };
  if (body.providerDisabled || body.code === 'OPERATION_NOT_ALLOWED') {
    return { mode: 'invite_fallback' };
  }
  if (!res.ok || !body.uid) {
    throw new Error(body.error || 'Failed to provision authentication user.');
  }
  return {
    mode: 'auth_created',
    uid: body.uid,
    email: body.email || params.email,
    verificationSent: Boolean(body.verificationSent),
  };
}
