'use client';

import { Check, Loader2, Edit } from 'lucide-react';
import { useCanvasStore } from '../store';

/**
 * Ambient sync status indicator for optimistic sync (Chapter 2)
 * Shows: Synced, Syncing, or Unsaved changes states
 */
export function SyncStatusIndicator() {
  const hasUnsavedChanges = useCanvasStore((state) => state.hasUnsavedChanges);
  const isSyncing = useCanvasStore((state) => state.isSyncing);

  if (isSyncing) {
    return (
      <div className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-50 border border-blue-200 rounded-full text-blue-700 text-xs font-medium">
        <Loader2 className="w-4 h-4 animate-spin" />
        <span>Syncing...</span>
      </div>
    );
  }

  if (hasUnsavedChanges) {
    return (
      <div className="flex items-center gap-1.5 px-3 py-1.5 bg-amber-50 border border-amber-200 rounded-full text-amber-800 text-xs font-medium">
        <Edit className="w-3 h-3" />
        <span>Unsaved changes</span>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-50 border border-emerald-200 rounded-full text-emerald-800 text-xs font-medium">
      <Check className="w-4 h-4" />
      <span>All changes saved</span>
    </div>
  );
}
