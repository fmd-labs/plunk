import {Input, Label} from '@plunk/ui';

/** "About 2 h 30 min" for a campaign of `recipients` at `sendsPerHour`, or null without a cap (fork D36). */
export function pacingEta(recipients: number, sendsPerHour: number | null | undefined): string | null {
  if (!sendsPerHour || recipients <= 0) {
    return null;
  }
  const minutes = Math.ceil((recipients / sendsPerHour) * 60);
  if (minutes < 60) {
    return `About ${minutes} min`;
  }
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `About ${hours} h` : `About ${hours} h ${rest} min`;
}

interface CampaignPacingFieldProps {
  value: number | null | undefined;
  onChange: (sendsPerHour: number | null) => void;
  /** The audience size, for the time the send takes. */
  recipients?: number;
  disabled?: boolean;
}

/**
 * The most recipients a campaign reaches per hour (fork D36). Empty for no cap: the campaign goes out
 * as fast as the project's sending rate allows.
 */
export function CampaignPacingField({value, onChange, recipients, disabled}: CampaignPacingFieldProps) {
  const eta = recipients !== undefined ? pacingEta(recipients, value) : null;

  return (
    <div className="space-y-2">
      <Label htmlFor="sendsPerHour">Pacing</Label>
      <div className="flex items-center gap-2">
        <Input
          id="sendsPerHour"
          type="number"
          min={1}
          step={1}
          inputMode="numeric"
          className="w-40"
          placeholder="No limit"
          value={value ?? ''}
          disabled={disabled}
          onChange={e => {
            const next = Number.parseInt(e.target.value, 10);
            onChange(Number.isFinite(next) && next > 0 ? next : null);
          }}
        />
        <span className="text-sm text-neutral-500">emails per hour</span>
      </div>
      <p className="text-sm text-neutral-500">
        Spreads the send out, for a new sending domain or a large list.{eta ? ` ${eta} for this audience.` : ''}
      </p>
    </div>
  );
}
