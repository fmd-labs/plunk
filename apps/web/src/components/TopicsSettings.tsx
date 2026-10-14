import {useState} from 'react';
import type {Project} from '@plunk/db';
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
} from '@plunk/ui';
import {Pencil, Plus, Tags, Trash2} from 'lucide-react';
import {ProjectSchemas, TopicSchemas} from '@plunk/shared';
import {toast} from 'sonner';
import useSWR from 'swr';
import {useActiveProject} from '../lib/contexts/ActiveProjectProvider';
import {network} from '../lib/network';

/** A topic as `GET /topics` returns it (fork D32). */
export interface Topic {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  basis: 'OPT_IN' | 'OPT_OUT';
  campaignSelectable: boolean;
  listId: string | null;
}

interface TopicDraft {
  slug: string;
  name: string;
  description: string;
  basis: 'OPT_IN' | 'OPT_OUT';
  campaignSelectable: boolean;
  listId: string;
}

const EMPTY_DRAFT: TopicDraft = {
  slug: '',
  name: '',
  description: '',
  basis: 'OPT_OUT',
  campaignSelectable: true,
  listId: '',
};

/** Settings tab for a project's topics (fork D32): the switch that turns them on, and the topics themselves. */
export function TopicsSettings() {
  const {activeProject, updateActiveProject} = useActiveProject();
  const {data: topics, mutate} = useSWR<Topic[]>(activeProject ? '/topics' : null);
  const [editing, setEditing] = useState<{draft: TopicDraft; isNew: boolean} | null>(null);
  const [deleting, setDeleting] = useState<Topic | null>(null);
  const [saving, setSaving] = useState(false);

  if (!activeProject) {
    return null;
  }

  const setEnabled = async (topicsEnabled: boolean) => {
    try {
      const project = await network.fetch<Project, typeof ProjectSchemas.update>(
        'PATCH',
        `/users/@me/projects/${activeProject.id}`,
        {topicsEnabled},
      );
      updateActiveProject(project);
      toast.success(topicsEnabled ? 'Topics turned on' : 'Topics turned off');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Couldn’t change the setting. Try again.');
    }
  };

  const save = async () => {
    if (!editing) return;
    const {draft} = editing;
    setSaving(true);
    try {
      await network.fetch<Topic, typeof TopicSchemas.upsert>('PUT', `/topics/${encodeURIComponent(draft.slug)}`, {
        name: draft.name,
        description: draft.description || null,
        basis: draft.basis,
        campaignSelectable: draft.campaignSelectable,
        listId: draft.listId || null,
      });
      await mutate();
      setEditing(null);
      toast.success(editing.isNew ? 'Topic created' : 'Topic saved');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Couldn’t save the topic. Try again.');
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!deleting) return;
    try {
      await network.fetch('DELETE', `/topics/${encodeURIComponent(deleting.slug)}`);
      await mutate();
      toast.success('Topic deleted');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Couldn’t delete the topic. Try again.');
    } finally {
      setDeleting(null);
    }
  };

  const update = (patch: Partial<TopicDraft>) =>
    setEditing(current => current && {...current, draft: {...current.draft, ...patch}});

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Tags className="h-5 w-5" />
            Topics
          </CardTitle>
          <CardDescription>
            Send each campaign for one topic, such as product news or a newsletter. A campaign reaches only contacts
            subscribed to its topic, and its unsubscribe link drops that topic alone.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between gap-4 rounded-lg border border-neutral-200 p-4">
            <div className="space-y-1">
              <Label htmlFor="topics-enabled">Send campaigns per topic</Label>
              <p className="text-sm text-neutral-500">
                Every campaign then needs a topic, transactional campaigns are off (send that mail through the API),
                workflows send transactional templates only, and new contacts start subscribed, since “subscribed” then
                only means “not suppressed”.
              </p>
            </div>
            <Switch id="topics-enabled" checked={activeProject.topicsEnabled} onCheckedChange={setEnabled} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
          <div className="space-y-1.5">
            <CardTitle>Project topics</CardTitle>
            <CardDescription>
              Opt-out topics reach every contact who has not unsubscribed from them; opt-in topics only contacts who
              subscribed.
            </CardDescription>
          </div>
          <Button size="sm" onClick={() => setEditing({draft: EMPTY_DRAFT, isNew: true})}>
            <Plus className="h-4 w-4" />
            Add topic
          </Button>
        </CardHeader>
        <CardContent>
          {!topics || topics.length === 0 ? (
            <EmptyState icon={Tags} title="No topics yet" description="Add a topic to send campaigns for it." />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Topic</TableHead>
                  <TableHead>Basis</TableHead>
                  <TableHead>Campaigns</TableHead>
                  <TableHead className="w-24" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {topics.map(topic => (
                  <TableRow key={topic.id}>
                    <TableCell>
                      <div className="font-medium text-neutral-900">{topic.name}</div>
                      <div className="font-mono text-xs text-neutral-500">{topic.slug}</div>
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary">{topic.basis === 'OPT_IN' ? 'Opt-in' : 'Opt-out'}</Badge>
                    </TableCell>
                    <TableCell className="text-sm text-neutral-600">
                      {topic.campaignSelectable ? 'Yes' : 'Segments only'}
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label={`Edit ${topic.name}`}
                          onClick={() =>
                            setEditing({
                              isNew: false,
                              draft: {
                                slug: topic.slug,
                                name: topic.name,
                                description: topic.description ?? '',
                                basis: topic.basis,
                                campaignSelectable: topic.campaignSelectable,
                                listId: topic.listId ?? '',
                              },
                            })
                          }
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="destructiveGhost"
                          size="sm"
                          aria-label={`Delete ${topic.name}`}
                          onClick={() => setDeleting(topic)}
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
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing?.isNew ? 'Add topic' : 'Edit topic'}</DialogTitle>
            <DialogDescription>
              The slug identifies the topic in the API and cannot change once the topic exists.
            </DialogDescription>
          </DialogHeader>
          {editing && (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="topic-slug">Slug</Label>
                <Input
                  id="topic-slug"
                  value={editing.draft.slug}
                  disabled={!editing.isNew}
                  placeholder="product-news"
                  onChange={e => update({slug: e.target.value.toLowerCase()})}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="topic-name">Name</Label>
                <Input
                  id="topic-name"
                  value={editing.draft.name}
                  placeholder="Product news"
                  onChange={e => update({name: e.target.value})}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="topic-description">Description</Label>
                <Textarea
                  id="topic-description"
                  value={editing.draft.description}
                  onChange={e => update({description: e.target.value})}
                />
              </div>
              <div className="space-y-2">
                <Label>Basis</Label>
                <Select
                  value={editing.draft.basis}
                  onValueChange={value => update({basis: value as TopicDraft['basis']})}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="OPT_OUT">Opt-out: everyone until they unsubscribe</SelectItem>
                    <SelectItem value="OPT_IN">Opt-in: only who subscribed</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-center justify-between gap-4">
                <Label htmlFor="topic-campaigns">Campaigns can be sent for this topic</Label>
                <Switch
                  id="topic-campaigns"
                  checked={editing.draft.campaignSelectable}
                  onCheckedChange={campaignSelectable => update({campaignSelectable})}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="topic-list-id">List-Id header</Label>
                <Input
                  id="topic-list-id"
                  value={editing.draft.listId}
                  placeholder="Product news <product-news.example.com>"
                  onChange={e => update({listId: e.target.value})}
                />
                <p className="text-xs text-neutral-500">
                  Optional. Mailbox providers use it to tell this topic’s mail apart from your other mail.
                </p>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button onClick={save} disabled={saving || !editing?.draft.slug || !editing?.draft.name}>
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
        description="Every contact’s subscription to this topic is deleted, and campaigns sent for it lose the link. Campaigns not yet sent need a new topic."
        confirmText="Delete topic"
        variant="destructive"
      />
    </div>
  );
}
