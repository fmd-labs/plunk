import {Label, Select, SelectContent, SelectItemWithDescription, SelectTrigger, SelectValue} from '@plunk/ui';
import Link from 'next/link';
import useSWR from 'swr';
import {useActiveProject} from '../lib/contexts/ActiveProjectProvider';
import type {Topic} from './TopicsSettings';

interface CampaignTopicSelectProps {
  value: string;
  onChange: (topicId: string) => void;
  disabled?: boolean;
}

/**
 * The topic a campaign is sent for (fork D32). Renders nothing in a project without topics; in one
 * with topics, a campaign reaches only the contacts subscribed to its topic.
 */
export function CampaignTopicSelect({value, onChange, disabled}: CampaignTopicSelectProps) {
  const {activeProject} = useActiveProject();
  const {data: topics} = useSWR<Topic[]>(activeProject?.topicsEnabled ? '/topics' : null, {revalidateOnFocus: false});

  if (!activeProject?.topicsEnabled) {
    return null;
  }

  const selectable = (topics ?? []).filter(topic => topic.campaignSelectable);

  return (
    <div className="space-y-2">
      <Label htmlFor="topic">
        Topic <span className="text-red-500">*</span>
      </Label>
      <Select value={value || undefined} onValueChange={onChange} disabled={disabled || selectable.length === 0}>
        <SelectTrigger id="topic">
          <SelectValue
            placeholder={!topics ? 'Loading topics…' : selectable.length > 0 ? 'Choose a topic' : 'No topics available'}
          />
        </SelectTrigger>
        <SelectContent>
          {selectable.map(topic => (
            <SelectItemWithDescription
              key={topic.id}
              value={topic.id}
              title={topic.name}
              description={
                topic.description ||
                (topic.basis === 'OPT_IN' ? 'Contacts who subscribed' : 'Contacts who have not unsubscribed')
              }
            />
          ))}
        </SelectContent>
      </Select>
      <p className="text-sm text-neutral-500">
        Only contacts subscribed to this topic receive the campaign.
        {topics && selectable.length === 0 && (
          <>
            {' '}
            <Link href="/settings?tab=topics" className="underline">
              Add a topic
            </Link>{' '}
            first.
          </>
        )}
      </p>
    </div>
  );
}
