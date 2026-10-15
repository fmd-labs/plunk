import {Select, SelectContent, SelectItem, SelectTrigger, SelectValue} from '@plunk/ui';
import Link from 'next/link';

import {type Layout, resolveLayout} from '../lib/hooks/useLayouts';

interface LayoutSelectProps {
  layouts: Layout[] | undefined;
  /** The layout picked; `undefined` shows the project's default, `null` none. */
  value: string | null | undefined;
  onChange: (layoutId: string | null) => void;
  disabled?: boolean;
}

const NONE = 'none';

/**
 * The layout a template's or campaign's body is sent in (fork D34). Renders nothing in a project
 * without layouts.
 */
export function LayoutSelect({layouts, value, onChange, disabled}: LayoutSelectProps) {
  if (!layouts || layouts.length === 0) {
    return null;
  }

  const current = resolveLayout(layouts, value);

  return (
    <div className="flex items-center gap-2">
      <span className="text-sm text-neutral-500">Layout</span>
      <Select
        value={current?.id ?? NONE}
        onValueChange={next => onChange(next === NONE ? null : next)}
        disabled={disabled}
      >
        <SelectTrigger className="h-8 w-48" aria-label="Layout">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE}>No layout</SelectItem>
          {layouts.map(layout => (
            <SelectItem key={layout.id} value={layout.id}>
              {layout.name}
              {layout.isDefault ? ' (default)' : ''}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {/* A new tab, so that an unsaved template or campaign is not left behind. */}
      <Link href="/settings?tab=layouts" target="_blank" className="text-xs text-neutral-500 underline">
        Edit
      </Link>
    </div>
  );
}
