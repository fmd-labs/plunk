import {useState} from 'react';
import {Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, Switch} from '@plunk/ui';
import {TopicSchemas} from '@plunk/shared';
import {toast} from 'sonner';
import useSWR from 'swr';
import {useActiveProject} from '../lib/contexts/ActiveProjectProvider';
import {network} from '../lib/network';

interface ContactTopicState {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  basis: 'OPT_IN' | 'OPT_OUT';
  subscribed: boolean;
  explicit: boolean | null;
}

/** A contact's subscription to each topic of the project (fork D32). Renders nothing without topics. */
export function ContactTopics({contactId}: {contactId: string}) {
  const {activeProject} = useActiveProject();
  const key = activeProject?.topicsEnabled ? `/contacts/${contactId}/topics` : null;
  const {data, mutate} = useSWR<{topics: ContactTopicState[]}>(key);
  // The topic whose change is on its way, so its switch does not look dead meanwhile.
  const [pending, setPending] = useState<string | null>(null);

  if (!key || !data || data.topics.length === 0) {
    return null;
  }

  const setSubscribed = async (topic: ContactTopicState, subscribed: boolean) => {
    setPending(topic.slug);
    try {
      const updated = await network.fetch<{topics: ContactTopicState[]}, typeof TopicSchemas.contactStates>(
        'PUT',
        `/contacts/${contactId}/topics`,
        {topics: {[topic.slug]: subscribed}},
      );
      await mutate(updated, {revalidate: false});
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Couldn’t change the subscription. Try again.');
    } finally {
      setPending(null);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Topics</CardTitle>
        <CardDescription>
          Campaigns reach this contact only for the topics it is subscribed to, and only while it is subscribed above.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {data.topics.map(topic => (
          <div key={topic.id} className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-neutral-900">{topic.name}</span>
                {topic.explicit === null && (
                  <Badge variant="neutral">{topic.basis === 'OPT_IN' ? 'Opt-in' : 'Opt-out'} default</Badge>
                )}
              </div>
              {topic.description && <p className="text-xs text-neutral-500 truncate">{topic.description}</p>}
            </div>
            <Switch
              checked={topic.subscribed}
              disabled={pending !== null}
              aria-busy={pending === topic.slug || undefined}
              onCheckedChange={subscribed => setSubscribed(topic, subscribed)}
              aria-label={`Subscribed to ${topic.name}`}
            />
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
