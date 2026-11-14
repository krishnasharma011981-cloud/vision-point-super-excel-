import { MapPin, Search, ShieldCheck } from 'lucide-react';
import React, { useMemo, useState } from 'react';
import { CENTRE_MAP } from '../constants/centres';
import { formatDateTime } from '../lib/csvUtils';
import type { ActivityLog, CentreId, LocationVerification, UserAccount } from '../types/domain';

interface ActivityLogsViewProps {
  currentUser: UserAccount;
  activityLogs: ActivityLog[];
  locationVerifications: LocationVerification[];
  selectedCentreFilter: CentreId | 'all';
}

export const ActivityLogsView: React.FC<ActivityLogsViewProps> = ({
  currentUser,
  activityLogs,
  locationVerifications,
  selectedCentreFilter,
}) => {
  const [tab, setTab] = useState<'audit' | 'location'>('audit');
  const [search, setSearch] = useState('');

  const effectiveCentre =
    currentUser.role === 'super_admin' ? selectedCentreFilter : currentUser.centreId;

  const filteredLogs = useMemo(() => {
    return activityLogs
      .filter((l) => (effectiveCentre === 'all' ? true : l.centreId === effectiveCentre))
      .filter((l) => (currentUser.role === 'employee' ? l.actorUid === currentUser.uid : true))
      .filter((l) => {
        if (!search.trim()) return true;
        const q = search.trim().toLowerCase();
        return (
          l.action.toLowerCase().includes(q) ||
          l.actorName.toLowerCase().includes(q) ||
          l.actorEmail.toLowerCase().includes(q) ||
          l.details.toLowerCase().includes(q)
        );
      });
  }, [activityLogs, effectiveCentre, currentUser, search]);

  const filteredGeo = useMemo(() => {
    return locationVerifications
      .filter((v) => (effectiveCentre === 'all' ? true : v.centreId === effectiveCentre))
      .filter((v) => (currentUser.role === 'employee' ? v.uid === currentUser.uid : true))
      .filter((v) => {
        if (!search.trim()) return true;
        const q = search.trim().toLowerCase();
        return v.userEmail.toLowerCase().includes(q) || v.operation.toLowerCase().includes(q);
      });
  }, [locationVerifications, effectiveCentre, currentUser, search]);

  return (
    <div className="space-y-5">
      <div className="glass-light-card rounded-2xl border border-slate-200/80 p-5 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h2 className="text-lg font-bold text-slate-900">Security Audit &amp; Location Verification Logs</h2>
          <p className="text-xs text-slate-700 mt-0.5">
            Immutable operational audit trail and server-verified GPS geofence checks.
          </p>
        </div>
        <div className="flex items-center gap-1 p-1 bg-slate-100 border border-slate-200 rounded-xl">
          <button
            type="button"
            onClick={() => setTab('audit')}
            className={`px-3 py-1.5 text-xs font-bold rounded-lg transition-colors ${
              tab === 'audit' ? 'btn-crimson-gloss text-white' : 'text-slate-700 hover:text-slate-900'
            }`}
          >
            Activity Logs ({filteredLogs.length})
          </button>
          <button
            type="button"
            onClick={() => setTab('location')}
            className={`px-3 py-1.5 text-xs font-bold rounded-lg transition-colors ${
              tab === 'location' ? 'btn-crimson-gloss text-white' : 'text-slate-700 hover:text-slate-900'
            }`}
          >
            Location Checks ({filteredGeo.length})
          </button>
        </div>
      </div>

      <div className="bg-white rounded-xl border border-zinc-200 p-4">
        <div className="relative">
          <Search className="w-4 h-4 text-zinc-600 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by actor, email, action, or operation details..."
            className="w-full pl-9 pr-3.5 py-2 text-sm bg-white text-black placeholder:text-zinc-500 border border-zinc-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-black"
          />
        </div>
      </div>

      <div className="bg-white rounded-xl border border-zinc-200 overflow-hidden">
        {tab === 'audit' ? (
          filteredLogs.length === 0 ? (
            <div className="p-10 text-center text-xs text-zinc-700">
              <ShieldCheck className="w-8 h-8 text-zinc-400 mx-auto mb-2" />
              No activity log entries recorded in this scope.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-zinc-50 border-b border-zinc-200 text-[11px] font-bold text-zinc-700 uppercase tracking-wider">
                    <th className="py-3 px-4">Timestamp</th>
                    <th className="py-3 px-4">Actor</th>
                    <th className="py-3 px-4">Centre</th>
                    <th className="py-3 px-4">Action</th>
                    <th className="py-3 px-4">Details</th>
                    <th className="py-3 px-4">GPS Verified</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-200 text-xs">
                  {filteredLogs.map((log, idx) => (
                    <tr key={log.id || idx} className="hover:bg-zinc-50">
                      <td className="py-3 px-4 font-mono text-[11px] text-zinc-700 whitespace-nowrap">
                        {formatDateTime(log.createdAt)}
                      </td>
                      <td className="py-3 px-4">
                        <p className="font-semibold text-black">{log.actorName}</p>
                        <p className="text-[11px] text-zinc-700">{log.actorEmail}</p>
                      </td>
                      <td className="py-3 px-4 text-zinc-800">
                        {CENTRE_MAP[log.centreId as CentreId]?.code || log.centreId}
                      </td>
                      <td className="py-3 px-4 font-mono font-bold text-black">{log.action}</td>
                      <td className="py-3 px-4 text-zinc-800 max-w-md">{log.details}</td>
                      <td className="py-3 px-4">
                        <span className={log.locationVerified ? 'text-emerald-700 font-semibold' : 'text-red-700 font-semibold'}>
                          {log.locationVerified ? 'Verified' : 'Denied / Unverified'}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        ) : filteredGeo.length === 0 ? (
          <div className="p-10 text-center text-xs text-zinc-700">
            <MapPin className="w-8 h-8 text-zinc-400 mx-auto mb-2" />
            No GPS geofence verifications recorded yet.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-zinc-50 border-b border-zinc-200 text-[11px] font-bold text-zinc-700 uppercase tracking-wider">
                  <th className="py-3 px-4">Timestamp</th>
                  <th className="py-3 px-4">User Email</th>
                  <th className="py-3 px-4">Centre</th>
                  <th className="py-3 px-4">Operation</th>
                  <th className="py-3 px-4 text-right">Distance / Radius</th>
                  <th className="py-3 px-4">Result</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-200 text-xs">
                {filteredGeo.map((g, idx) => (
                  <tr key={g.id || idx} className="hover:bg-zinc-50">
                    <td className="py-3 px-4 font-mono text-[11px] text-zinc-700 whitespace-nowrap">
                      {formatDateTime(g.createdAt)}
                    </td>
                    <td className="py-3 px-4 font-medium text-black">{g.userEmail}</td>
                    <td className="py-3 px-4 text-zinc-800">{CENTRE_MAP[g.centreId]?.code || g.centreId}</td>
                    <td className="py-3 px-4 font-mono text-zinc-800">{g.operation}</td>
                    <td className="py-3 px-4 text-right font-mono tabular-nums text-black font-semibold">
                      {g.distanceMeters}m / {g.radiusMeters}m
                    </td>
                    <td className="py-3 px-4">
                      <span className={g.verified ? 'text-emerald-700 font-semibold' : 'text-red-700 font-semibold'}>
                        {g.verified ? (g.overrideApplied ? 'Allowed (Override)' : 'Within Fence') : 'Denied'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};
