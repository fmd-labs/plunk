import useSWR from 'swr';

/** A layout as `GET /layouts` returns it (fork D34). */
export interface Layout {
  id: string;
  slug: string;
  name: string;
  html: string;
  css: string | null;
  isDefault: boolean;
}

/** The active project's layouts (fork D34). */
export function useLayouts() {
  return useSWR<Layout[]>('/layouts', {revalidateOnFocus: false});
}

/**
 * The layout an email is shown in: the one with this id, the project's default for `undefined` (a new
 * template or campaign that has not picked one), and none for `null`.
 */
export function resolveLayout(layouts: Layout[] | undefined, layoutId: string | null | undefined): Layout | null {
  if (!layouts || layoutId === null) {
    return null;
  }
  return (
    (layoutId === undefined ? layouts.find(layout => layout.isDefault) : layouts.find(l => l.id === layoutId)) ?? null
  );
}
