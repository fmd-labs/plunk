import {useState} from 'react';
import {type CampaignSchemas, MAX_SENDS_PER_HOUR, pacedDurationMs} from '@plunk/shared';
import {Button, Input, Label} from '@plunk/ui';
import {toast} from 'sonner';
import {network} from '../lib/network';

/**
 * "About 2 h 30 min" for a campaign of `recipients` at `sendsPerHour`, or null without a cap or when the
 * audience fits in the first batch (fork D36).
 */
export function pacingEta(recipients: number, sendsPerHour: number | null | undefined): string | null {
  const minutes = Math.ceil(pacedDurationMs(sendsPerHour, recipients) / 60_000);
  if (minutes === 0) {
    return null;
  }
  if (minutes < 60) {
    return `About ${minutes} min`;
  }
  if (minutes < 48 * 60) {
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest === 0 ? `About ${hours} h` : `About ${hours} h ${rest} min`;
  }
  return `About ${Math.round(minutes / (24 * 60)).toLocaleString()} days`;
}

interface CampaignPacingFieldProps {
  value: number | null | undefined;
  onChange: (sendsPerHour: number | null) => void;
  /** The recipients to send to, for the time the send takes. */
  recipients?: number;
  /** Who `recipients` are, after the time the send takes. */
  recipientsLabel?: string;
  disabled?: boolean;
}

/**
 * The most recipients a campaign reaches per hour (fork D36). Empty for no cap: the campaign goes out
 * as fast as the project's sending rate allows.
 */
export function CampaignPacingField({
  value,
  onChange,
  recipients,
  recipientsLabel = 'this audience',
  disabled,
}: CampaignPacingFieldProps) {
  const eta = recipients !== undefined ? pacingEta(recipients, value) : null;

  return (
    <div className="space-y-2">
      <Label htmlFor="sendsPerHour">Pacing</Label>
      <div className="flex items-center gap-2">
        <Input
          id="sendsPerHour"
          type="number"
          min={1}
          max={MAX_SENDS_PER_HOUR}
          step={1}
          inputMode="numeric"
          className="w-40"
          placeholder="No limit"
          value={value ?? ''}
          disabled={disabled}
          onChange={e => {
            const next = Number(e.target.value);
            onChange(e.target.value && Number.isInteger(next) && next >= 1 ? Math.min(next, MAX_SENDS_PER_HOUR) : null);
          }}
        />
        <span className="text-sm text-neutral-500">emails per hour</span>
      </div>
      <p className="text-sm text-neutral-500">
        Spreads the send out, for a new sending domain or a large list.
        {eta ? ` ${eta} for ${recipientsLabel}.` : ''}
      </p>
    </div>
  );
}

interface CampaignPaceUpdateProps {
  campaignId: string;
  value: number | null | undefined;
  /** The recipients still to reach. */
  remaining: number;
  onSaved: () => void;
}

/**
 * Changes a sending campaign's pace (fork D36): the batches that follow use it. Keyed by the saved
 * value, so a save starts it over from the campaign.
 */
export function CampaignPaceUpdate({campaignId, value, remaining, onSaved}: CampaignPaceUpdateProps) {
  const [draft, setDraft] = useState<number | null>(value ?? null);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      await network.fetch<unknown, typeof CampaignSchemas.update>('PUT', `/campaigns/${campaignId}`, {
        sendsPerHour: draft,
      });
      toast.success(draft ? `Paced at ${draft.toLocaleString()} per hour from the next batch` : 'Pacing removed');
      onSaved();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Couldn’t change the pacing. Try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <CampaignPacingField
        value={draft}
        onChange={setDraft}
        recipients={remaining}
        recipientsLabel="the recipients left"
        disabled={saving}
      />
      <Button type="button" variant="outline" onClick={save} disabled={saving || draft === (value ?? null)}>
        {saving ? 'Saving…' : 'Update pacing'}
      </Button>
    </div>
  );
}
