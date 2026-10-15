import {useState} from 'react';
import {LayoutSchemas, layoutSlotCount} from '@plunk/shared';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  ConfirmDialog,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  Input,
  Label,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
} from '@plunk/ui';
import {LayoutTemplate, Pencil, Plus, Trash2} from 'lucide-react';
import {toast} from 'sonner';
import {type Layout, useLayouts} from '../lib/hooks/useLayouts';
import {network} from '../lib/network';

interface LayoutDraft {
  slug: string;
  name: string;
  html: string;
  css: string;
  isDefault: boolean;
}

const STARTER_HTML = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
  </head>
  <body class="body">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td align="center">
          <table role="presentation" class="container" width="600" cellpadding="0" cellspacing="0">
            <tr><td class="content">{{ content }}</td></tr>
            <tr>
              <td class="footer">
                You get this email at {{ email }}. <a href="{{ unsubscribeUrl }}">Unsubscribe</a>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

const STARTER_CSS = `.body { margin: 0; background: #f5f5f5; font-family: Arial, sans-serif; }
.container { max-width: 600px; background: #ffffff; }
.content { padding: 32px; color: #171717; font-size: 16px; line-height: 1.6; }
.footer { padding: 16px 32px; color: #737373; font-size: 12px; }
a.email-button { background-color: #171717; color: #ffffff; }`;

const EMPTY_DRAFT: LayoutDraft = {slug: '', name: '', html: STARTER_HTML, css: STARTER_CSS, isDefault: false};

/** Settings tab for a project's layouts (fork D34). */
export function LayoutsSettings() {
  const {data: layouts, mutate} = useLayouts();
  const [editing, setEditing] = useState<{draft: LayoutDraft; isNew: boolean} | null>(null);
  const [deleting, setDeleting] = useState<Layout | null>(null);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!editing) return;
    const {draft} = editing;
    if (editing.isNew && layouts?.some(layout => layout.slug === draft.slug)) {
      toast.error(`A layout with the slug “${draft.slug}” exists already`);
      return;
    }
    setSaving(true);
    try {
      await network.fetch<Layout, typeof LayoutSchemas.upsert>('PUT', `/layouts/${encodeURIComponent(draft.slug)}`, {
        name: draft.name,
        html: draft.html,
        css: draft.css || null,
        isDefault: draft.isDefault,
      });
      await mutate();
      setEditing(null);
      toast.success(editing.isNew ? 'Layout created' : 'Layout saved');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Couldn’t save the layout. Try again.');
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!deleting) return;
    try {
      await network.fetch('DELETE', `/layouts/${encodeURIComponent(deleting.slug)}`);
      await mutate();
      toast.success('Layout deleted');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Couldn’t delete the layout. Try again.');
    } finally {
      setDeleting(null);
    }
  };

  const update = (patch: Partial<LayoutDraft>) =>
    setEditing(current => current && {...current, draft: {...current.draft, ...patch}});

  const slots = editing ? layoutSlotCount(editing.draft.html) : 1;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
          <div className="space-y-1.5">
            <CardTitle className="flex items-center gap-2">
              <LayoutTemplate className="h-5 w-5" />
              Layouts
            </CardTitle>
            <CardDescription>
              The HTML your templates and campaigns are sent in: a header, a footer and styles around the{' '}
              {'{{ content }}'} slot. The CSS is inlined into every email. A layout that links to{' '}
              {'{{ unsubscribeUrl }}'} replaces Plunk’s footer. New templates and campaigns start with the default
              layout.
            </CardDescription>
          </div>
          <Button size="sm" onClick={() => setEditing({draft: EMPTY_DRAFT, isNew: true})}>
            <Plus className="h-4 w-4" />
            Add layout
          </Button>
        </CardHeader>
        <CardContent>
          {!layouts ? null : layouts.length === 0 ? (
            <EmptyState
              icon={LayoutTemplate}
              title="No layouts yet"
              description="Add a layout to send your emails in your own design."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Layout</TableHead>
                  <TableHead className="w-24" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {layouts.map(layout => (
                  <TableRow key={layout.id}>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-neutral-900">{layout.name}</span>
                        {layout.isDefault && <Badge variant="secondary">Default</Badge>}
                      </div>
                      <div className="font-mono text-xs text-neutral-500">{layout.slug}</div>
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label={`Edit ${layout.name}`}
                          onClick={() =>
                            setEditing({
                              isNew: false,
                              draft: {
                                slug: layout.slug,
                                name: layout.name,
                                html: layout.html,
                                css: layout.css ?? '',
                                isDefault: layout.isDefault,
                              },
                            })
                          }
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="destructiveGhost"
                          size="sm"
                          aria-label={`Delete ${layout.name}`}
                          onClick={() => setDeleting(layout)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Dialog open={editing !== null} onOpenChange={open => !open && setEditing(null)}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>{editing?.isNew ? 'Add layout' : 'Edit layout'}</DialogTitle>
            <DialogDescription>
              The slug identifies the layout in the API and cannot change once the layout exists.
            </DialogDescription>
          </DialogHeader>
          {editing && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="layout-name">Name</Label>
                  <Input
                    id="layout-name"
                    value={editing.draft.name}
                    placeholder="Newsletter"
                    onChange={e => update({name: e.target.value})}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="layout-slug">Slug</Label>
                  <Input
                    id="layout-slug"
                    value={editing.draft.slug}
                    disabled={!editing.isNew}
                    placeholder="newsletter"
                    onChange={e => update({slug: e.target.value.toLowerCase()})}
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="layout-html">HTML</Label>
                <Textarea
                  id="layout-html"
                  value={editing.draft.html}
                  rows={12}
                  className="font-mono text-xs"
                  onChange={e => update({html: e.target.value})}
                />
                <p className={`text-xs ${slots === 1 ? 'text-neutral-500' : 'text-red-600'}`}>
                  {slots === 1
                    ? 'The body goes into the {{ content }} slot. Placeholders such as {{ email }} and {{ unsubscribeUrl }} work as in a template.'
                    : `A layout needs exactly one {{ content }} slot; this one has ${slots}.`}
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="layout-css">CSS</Label>
                <Textarea
                  id="layout-css"
                  value={editing.draft.css}
                  rows={6}
                  className="font-mono text-xs"
                  onChange={e => update({css: e.target.value})}
                />
                <p className="text-xs text-neutral-500">
                  Inlined into each email, for the layout and the body alike. Style the editor’s buttons with{' '}
                  <code>a.email-button</code>.
                </p>
              </div>
              <div className="flex items-center justify-between gap-4">
                <Label htmlFor="layout-default">New templates and campaigns start with this layout</Label>
                <Switch
                  id="layout-default"
                  checked={editing.draft.isDefault}
                  onCheckedChange={isDefault => update({isDefault})}
                />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button onClick={save} disabled={saving || !editing?.draft.slug || !editing?.draft.name || slots !== 1}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={open => !open && setDeleting(null)}
        onConfirm={remove}
        title={`Delete “${deleting?.name ?? ''}”?`}
        description="Templates and draft campaigns in this layout are sent without one afterwards."
        confirmText="Delete layout"
        variant="destructive"
      />
    </div>
  );
}
