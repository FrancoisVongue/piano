'use client';

import React, { useCallback, useState } from 'react';
import {
  Wrench,
  ChevronDown,
  RotateCcw,
  Zap,
  Combine,
  Workflow as WorkflowIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { useActionsContext } from '@/domain/action/ActionsContext';
import { useUnifiersStore } from '@/domain/unifier/store';
import { ReorderableHotkeyList } from '@/lib/ReorderableHotkeyList';
import { partitionByVisibility } from '@/lib/visibilityOrder';

const HOTKEY_LABELS = ['a', 's', 'd', 'f'] as const;

interface Props {
  disabled?: boolean;
}

const OperationsButtonComponent = ({ disabled }: Props) => {
  const { allActions, actionsConfig, updateActionsConfig } = useActionsContext();
  const unifiers = useUnifiersStore((state) => state.unifiers);
  const fetchUnifiers = useUnifiersStore((state) => state.fetchUnifiers);
  const [hasLoadedUnifiers, setHasLoadedUnifiers] = useState(false);

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (open && !hasLoadedUnifiers) {
        void fetchUnifiers();
        setHasLoadedUnifiers(true);
      }
    },
    [fetchUnifiers, hasLoadedUnifiers]
  );

  const hasCustomConfig = actionsConfig !== null;
  const { visible, hidden } = partitionByVisibility(allActions, actionsConfig?.visibleIds);

  const onReorder = useCallback(
    (nextIds: string[]) => {
      updateActionsConfig({ visibleIds: nextIds });
    },
    [updateActionsConfig]
  );

  const onToggleVisibility = useCallback(
    (id: string) => {
      const cur = actionsConfig?.visibleIds ?? allActions.map((action) => action.id);
      const next = cur.includes(id) ? cur.filter((value) => value !== id) : [...cur, id];
      updateActionsConfig(next.length === 0 ? null : { visibleIds: next });
    },
    [actionsConfig, allActions, updateActionsConfig]
  );

  const totalCount = allActions.length + unifiers.length;

  return (
    <Popover onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          disabled={disabled}
          className={cn(
            'gap-1.5 text-xs font-medium',
            'border-gray-200 hover:bg-gray-50',
            hasCustomConfig && 'border-amber-300 bg-amber-50 hover:bg-amber-100'
          )}
        >
          <Wrench className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">Operations</span>
          <span className="rounded-full bg-gray-100 px-1.5 py-0.5 text-[10px] leading-none text-gray-700">
            {hasCustomConfig ? `${visible.length}/${allActions.length}` : totalCount}
          </span>
          <ChevronDown className="h-3 w-3 opacity-50" />
        </Button>
      </PopoverTrigger>

      <PopoverContent className="w-[440px] p-0">
        <div className="flex items-center justify-between border-b px-3 py-2">
          <span className="text-xs font-semibold tracking-wider text-gray-500 uppercase">
            Operations
          </span>
          <div className="flex items-center gap-3">
            <span className="text-[10px] font-normal text-gray-400">Alt + a s d f - top 4</span>
            {hasCustomConfig && (
              <button
                type="button"
                onClick={() => updateActionsConfig(null)}
                className="flex items-center gap-1 text-xs text-gray-400 hover:text-gray-600"
              >
                <RotateCcw className="h-3 w-3" />
                Reset
              </button>
            )}
          </div>
        </div>

        <div className="max-h-[480px] overflow-y-auto">
          <SectionHeader
            icon={<Zap className="h-3 w-3 text-amber-500" />}
            label="Actions"
            count={allActions.length}
          />
          {allActions.length === 0 ? (
            <div className="px-3 py-3 text-xs text-gray-400 italic">No actions defined</div>
          ) : (
            <ReorderableHotkeyList
              visibleItems={visible}
              hiddenItems={hidden}
              hotkeyLabels={HOTKEY_LABELS}
              onReorder={onReorder}
              onToggleVisibility={onToggleVisibility}
              renderItemBody={(action) => (
                <>
                  <Zap className="h-3.5 w-3.5 flex-shrink-0 text-amber-500" />
                  <span className="flex-1 truncate">{action.name}</span>
                </>
              )}
              renderHiddenItemBody={(action) => (
                <>
                  <Zap className="h-3.5 w-3.5 flex-shrink-0 text-gray-300" />
                  <span className="flex-1 truncate text-gray-400">{action.name}</span>
                </>
              )}
              hideTooltip="Hide action"
            />
          )}

          <SectionHeader
            icon={<Combine className="h-3 w-3 text-emerald-600" />}
            label="Unifiers"
            count={unifiers.length}
          />
          {unifiers.length === 0 ? (
            <div className="px-3 py-3 text-xs text-gray-400 italic">No unifiers yet</div>
          ) : (
            <ul className="p-1">
              {unifiers.map((unifier) => (
                <li
                  key={unifier.id}
                  className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-gray-50"
                >
                  <span className="w-4 flex-shrink-0" />
                  <Combine className="h-3.5 w-3.5 flex-shrink-0 text-emerald-600" />
                  <span className="flex-1 truncate">{unifier.name}</span>
                </li>
              ))}
            </ul>
          )}

          <SectionHeader
            icon={<WorkflowIcon className="h-3 w-3 text-indigo-500" />}
            label="Workflows"
            count={0}
          />
          <div className="px-3 py-3 text-xs text-gray-400 italic">
            Workflows coming with the orchestration layer
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
};

function SectionHeader({
  icon,
  label,
  count,
}: {
  icon: React.ReactNode;
  label: string;
  count: number;
}) {
  return (
    <div className="sticky top-0 z-10 flex items-center justify-between gap-2 border-b border-gray-100 bg-white/95 px-3 py-1.5 text-[10px] tracking-wider text-gray-500 uppercase backdrop-blur-sm">
      <div className="flex items-center gap-1.5">
        {icon}
        <span className="font-semibold">{label}</span>
      </div>
      <span className="text-gray-400 normal-case">{count}</span>
    </div>
  );
}

export const OperationsButton = React.memo(OperationsButtonComponent);
