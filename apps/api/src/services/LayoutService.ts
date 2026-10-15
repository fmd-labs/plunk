import {CampaignStatus, type Layout} from '@plunk/db';
import {applyLayout, LAYOUT_BUTTON_CSS, layoutHasUnsubscribeLink, withStyleBlock} from '@plunk/shared';
import juice from 'juice';

import {prisma} from '../database/prisma.js';
import {ErrorCode, HttpException, NotFound} from '../exceptions/index.js';
import {LAYOUT_HEADER} from './EmailHeaderService.js';

/**
 * Layouts (fork D34): an HTML document with one `{{ content }}` slot that a template's or campaign's
 * body is sent in, and CSS that is inlined into every email sent in it.
 *
 * - **At send creation** the body's source is put into the slot (`composeBody`) before the email's one
 *   template pass (D28), and the email notes the layout in an internal header (`LAYOUT_HEADER`).
 * - **In the worker** the noted layout finishes the rendered email (`finishWithLayout`): its CSS is
 *   inlined, and a layout that links to the recipient's unsubscribe page itself replaces Plunk's footer.
 */

export interface LayoutInput {
  name: string;
  html: string;
  css?: string | null;
  isDefault?: boolean;
}

/** The parts of a layout a send uses. */
export type SendLayout = Pick<Layout, 'id' | 'html' | 'css'>;

export class LayoutService {
  public static list(projectId: string): Promise<Layout[]> {
    return prisma.layout.findMany({where: {projectId}, orderBy: {createdAt: 'asc'}});
  }

  public static async get(projectId: string, slug: string): Promise<Layout> {
    const layout = await prisma.layout.findUnique({where: {projectId_slug: {projectId, slug}}});
    if (!layout) {
      throw new NotFound('layout', slug);
    }
    return layout;
  }

  /**
   * Create the layout with this slug, or update it; an update changes only the fields given. Making a
   * layout the default takes that from the project's other layouts.
   */
  public static async upsert(
    projectId: string,
    slug: string,
    input: LayoutInput,
  ): Promise<{layout: Layout; created: boolean}> {
    return prisma.$transaction(async tx => {
      const existing = await tx.layout.findUnique({where: {projectId_slug: {projectId, slug}}, select: {id: true}});
      if (input.isDefault) {
        await tx.layout.updateMany({where: {projectId, isDefault: true, slug: {not: slug}}, data: {isDefault: false}});
      }
      const layout = await tx.layout.upsert({
        where: {projectId_slug: {projectId, slug}},
        create: {
          projectId,
          slug,
          name: input.name,
          html: input.html,
          css: input.css ?? null,
          isDefault: input.isDefault ?? false,
        },
        update: {name: input.name, html: input.html, css: input.css, isDefault: input.isDefault},
      });
      return {layout, created: !existing};
    });
  }

  /**
   * Delete a layout. Templates and draft campaigns in it go without one. Refused (409) while a campaign
   * is scheduled or sending in it, whose later emails would otherwise go out without it.
   */
  public static async delete(projectId: string, slug: string): Promise<void> {
    const layout = await this.get(projectId, slug);
    const campaigns = await prisma.campaign.findMany({
      where: {layoutId: layout.id, status: {in: [CampaignStatus.SCHEDULED, CampaignStatus.SENDING]}},
      select: {name: true},
    });
    if (campaigns.length > 0) {
      throw new HttpException(
        409,
        `The layout "${layout.name}" is in use by ${campaigns.map(c => `campaign "${c.name}"`).join(', ')}. Change or cancel those first.`,
        ErrorCode.CONFLICT,
      );
    }
    await prisma.layout.delete({where: {id: layout.id}});
  }

  /**
   * The layout a new template or campaign is created in: the one named (of this project), none for
   * `null`, and the project's default layout when the request leaves it out.
   */
  public static async forNew(projectId: string, layoutId: string | null | undefined): Promise<string | null> {
    if (layoutId === undefined) {
      const fallback = await prisma.layout.findFirst({
        where: {projectId, isDefault: true},
        orderBy: {updatedAt: 'desc'},
        select: {id: true},
      });
      return fallback?.id ?? null;
    }
    if (layoutId !== null) {
      await this.assertInProject(projectId, layoutId);
    }
    return layoutId;
  }

  /**
   * The layout an email notes it was composed in, if it still exists in the email's project. Kept for a
   * minute per worker, since every email of a campaign asks for the same one: a change reaches the
   * emails sent a minute later at most.
   */
  public static async forEmail(projectId: string, layoutId: string): Promise<Pick<Layout, 'html' | 'css'> | null> {
    const cached = layoutCache.get(layoutId);
    if (cached && cached.projectId === projectId && cached.expires > Date.now()) {
      return cached.layout;
    }
    const layout = await prisma.layout.findFirst({where: {id: layoutId, projectId}, select: {html: true, css: true}});
    if (layoutCache.size >= LAYOUT_CACHE_SIZE) {
      layoutCache.delete(layoutCache.keys().next().value!);
    }
    layoutCache.set(layoutId, {projectId, layout, expires: Date.now() + LAYOUT_CACHE_MS});
    return layout;
  }

  /** Refuse a layout id of another project, or of none. */
  public static async assertInProject(projectId: string, layoutId: string): Promise<void> {
    const layout = await prisma.layout.findFirst({where: {id: layoutId, projectId}, select: {id: true}});
    if (!layout) {
      throw new NotFound('layout', layoutId);
    }
  }
}

/**
 * The body's source in its layout, and the internal header that tells the worker which layout to
 * finish it with. Without a layout, the body and no header.
 */
export function composeBody(
  layout: SendLayout | null | undefined,
  body: string,
): {body: string; headers: Record<string, string>} {
  if (!layout) {
    return {body, headers: {}};
  }
  return {body: applyLayout(layout.html, body), headers: {[LAYOUT_HEADER]: layout.id}};
}

/**
 * A rendered email in the layout it was composed with, finished: the layout's CSS (and any `<style>`
 * in the document) inlined into `style` attributes, which mail clients honor where they drop
 * stylesheets. Media queries and font faces stay in a `<style>` block, since they cannot be inlined.
 */
export function inlineLayoutCss(html: string, css: string | null): string {
  const styled = withStyleBlock(html, `${LAYOUT_BUTTON_CSS}${css ?? ''}`);
  return juice(styled, {preserveMediaQueries: true, preserveFontFaces: true, removeStyleTags: true});
}

/** Whether the layout replaces Plunk's marketing footer: it links to the unsubscribe page itself. */
export function layoutReplacesFooter(layout: Pick<Layout, 'html'>): boolean {
  return layoutHasUnsubscribeLink(layout.html);
}

/**
 * Whether a rendered email links to the recipient's unsubscribe or preferences page where every client
 * shows it: in an `href`, outside HTML comments (which also hold Outlook-only `<!--[if mso]>` blocks).
 * Plunk's footer is left out only then, so that a marketing email never loses its only visible way out.
 */
export function hasVisibleUnsubscribeLink(html: string, contactId: string, unsubscribeUrl?: string): boolean {
  const visible = html.replace(/<!--[\s\S]*?-->/g, '');
  for (const match of visible.matchAll(/\bhref\s*=\s*(["'])(.*?)\1/gis)) {
    const href = (match[2] ?? '').replaceAll('&amp;', '&');
    if (
      href.includes(`/unsubscribe/${contactId}`) ||
      href.includes(`/manage/${contactId}`) ||
      (unsubscribeUrl !== undefined && href === unsubscribeUrl)
    ) {
      return true;
    }
  }
  return false;
}

/** Layouts a worker keeps (see `LayoutService.forEmail`), and for how long. */
const LAYOUT_CACHE_SIZE = 100;
const LAYOUT_CACHE_MS = 60_000;
const layoutCache = new Map<string, {projectId: string; layout: Pick<Layout, 'html' | 'css'> | null; expires: number}>();
