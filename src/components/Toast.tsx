import { AlertCircle, CheckCircle2, Info, ShieldAlert, X } from 'lucide-react';
import React from 'react';

export interface ToastMessage {
  id: string;
  title: string;
  description?: string;
  variant: 'success' | 'error' | 'warning' | 'info';
}

interface ToastContainerProps {
  toasts: ToastMessage[];
  onDismiss: (id: string) => void;
}

export const ToastContainer: React.FC<ToastContainerProps> = ({ toasts, onDismiss }) => {
  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-[90] flex flex-col gap-2.5 max-w-md w-full px-4 sm:px-0 pointer-events-none no-print">
      {toasts.map((toast) => {
        const styles =
          toast.variant === 'success'
            ? 'bg-white border-emerald-300 text-black'
            : toast.variant === 'error'
              ? 'bg-white border-red-300 text-black'
              : toast.variant === 'warning'
                ? 'bg-white border-amber-400 text-black'
                : 'bg-white border-zinc-300 text-black';

        const icon =
          toast.variant === 'success' ? (
            <CheckCircle2 className="w-5 h-5 text-emerald-700 shrink-0" />
          ) : toast.variant === 'error' ? (
            <ShieldAlert className="w-5 h-5 text-red-700 shrink-0" />
          ) : toast.variant === 'warning' ? (
            <AlertCircle className="w-5 h-5 text-[#B45309] shrink-0" />
          ) : (
            <Info className="w-5 h-5 text-black shrink-0" />
          );

        return (
          <div
            key={toast.id}
            role="alert"
            className={`pointer-events-auto flex items-start gap-3 p-4 rounded-xl border shadow-lg transition-all ${styles}`}
          >
            {icon}
            <div className="flex-1 min-w-0">
              <p className="text-sm font-bold text-black">{toast.title}</p>
              {toast.description && <p className="text-xs text-zinc-700 mt-1 leading-relaxed">{toast.description}</p>}
            </div>
            <button
              type="button"
              onClick={() => onDismiss(toast.id)}
              className="text-zinc-600 hover:text-black p-1 rounded-md shrink-0"
              aria-label="Dismiss notification"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        );
      })}
    </div>
  );
};
