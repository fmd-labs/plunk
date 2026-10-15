import {KeyRound} from 'lucide-react';
import {useApiKeys} from '../lib/hooks/useApiKeys';

interface KeyAttributionProps {
  createdByKeyId?: string | null;
  updatedByKeyId?: string | null;
}

/**
 * Which scoped API key created a campaign, template or segment, or changed it last (fork D37); nothing for what
 * people made.
 */
export function KeyAttribution({createdByKeyId, updatedByKeyId}: KeyAttributionProps) {
  const keyId = updatedByKeyId ?? createdByKeyId;
  const {data: keys} = useApiKeys(Boolean(keyId));
  if (!keyId || !keys) {
    return null;
  }
  const name = keys.find(key => key.id === keyId)?.name;

  return (
    <p className="flex items-center gap-1.5 text-xs text-neutral-500">
      <KeyRound className="h-3.5 w-3.5" />
      {updatedByKeyId ? 'Last changed with the API key' : 'Created with the API key'}
      {name && ` “${name}”`}
    </p>
  );
}
