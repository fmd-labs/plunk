import {useState} from 'react';
import {API_KEY_SCOPE_DESCRIPTIONS, API_KEY_SCOPES, type ApiKeyScope, type ApiKeySchemas} from '@plunk/shared';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Checkbox,
  ConfirmDialog,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@plunk/ui';
import {KeyRound, Plus, Trash2} from 'lucide-react';
import {toast} from 'sonner';
import {ApiKeyDisplay} from './ApiKeyDisplay';
import {formatRelativeTime} from '../lib/dateUtils';
import {type ApiKey, useApiKeys} from '../lib/hooks/useApiKeys';
import {network} from '../lib/network';

/**
 * A project's scoped API keys (fork D37): for agents and integrations that may call only part of the API. Every
 * member sees them; admins and owners (`canManage`) create and revoke them. A new key's secret is shown once.
 */
export function ScopedApiKeys({canManage}: {canManage: boolean}) {
  const {data: keys, mutate} = useApiKeys();
  const [draft, setDraft] = useState<{name: string; scopes: ApiKeyScope[]} | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<ApiKey | null>(null);
  const [saving, setSaving] = useState(false);

  const create = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      const created = await network.fetch<{secret: string}, typeof ApiKeySchemas.create>('POST', '/api-keys', draft);
      await mutate();
      setDraft(null);
      setSecret(created.secret);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Couldn’t create the key. Try again.');
    } finally {
      setSaving(false);
    }
  };

  const revoke = async () => {
    if (!revoking) return;
    try {
      await network.fetch('DELETE', `/api-keys/${revoking.id}`);
      await mutate();
      toast.success(`“${revoking.name}” revoked`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Couldn’t revoke the key. Try again.');
    } finally {
      setRevoking(null);
    }
  };

  const toggleScope = (scope: ApiKeyScope, on: boolean) =>
    setDraft(current =>
      current && {...current, scopes: on ? [...current.scopes, scope] : current.scopes.filter(s => s !== scope)},
    );

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
        <div className="space-y-1.5">
          <CardTitle className="flex items-center gap-2">
            <KeyRound className="h-5 w-5" />
            Scoped API keys
          </CardTitle>
          <CardDescription>
            Keys for agents and integrations that may call only part of the API, where the secret key above can do
            everything. Campaigns, templates and segments show the key that made them.
          </CardDescription>
        </div>
        {canManage && (
          <Button size="sm" variant="outline" onClick={() => setDraft({name: '', scopes: []})}>
            <Plus className="h-4 w-4" />
            Add key
          </Button>
        )}
      </CardHeader>
      {keys && keys.length > 0 && (
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Key</TableHead>
                <TableHead>Scopes</TableHead>
                <TableHead>Last used</TableHead>
                <TableHead className="w-12" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {keys.map(key => (
                <TableRow key={key.id} className={key.revokedAt ? 'opacity-60' : undefined}>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-neutral-900">{key.name}</span>
                      {key.revokedAt && <Badge variant="secondary">Revoked</Badge>}
                    </div>
                    <div className="font-mono text-xs text-neutral-500">{key.prefix}…</div>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {key.scopes.map(scope => (
                        <Badge key={scope} variant="outline">
                          {scope}
                        </Badge>
                      ))}
                    </div>
                  </TableCell>
                  <TableCell className="text-sm text-neutral-500">
                    {key.lastUsedAt ? formatRelativeTime(key.lastUsedAt) : 'Never'}
                  </TableCell>
                  <TableCell>
                    {canManage && !key.revokedAt && (
                      <Button
                        variant="destructiveGhost"
                        size="sm"
                        aria-label={`Revoke ${key.name}`}
                        onClick={() => setRevoking(key)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      )}

      <Dialog open={draft !== null} onOpenChange={open => !open && setDraft(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Add a scoped key</DialogTitle>
            <DialogDescription>The key may call only the routes of the scopes you pick.</DialogDescription>
          </DialogHeader>
          {draft && (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="apiKeyName">Name</Label>
                <Input
                  id="apiKeyName"
                  placeholder="Campaign drafting agent"
                  maxLength={100}
                  value={draft.name}
                  onChange={e => setDraft({...draft, name: e.target.value})}
                />
              </div>
              <div className="space-y-3">
                <Label>Scopes</Label>
                {API_KEY_SCOPES.map(scope => (
                  <label key={scope} className="flex items-start gap-3 rounded-lg border border-neutral-200 p-3">
                    <Checkbox
                      className="mt-0.5"
                      checked={draft.scopes.includes(scope)}
                      onCheckedChange={checked => toggleScope(scope, checked === true)}
                    />
                    <span className="space-y-0.5">
                      <span className="block text-sm font-medium text-neutral-900">{scope}</span>
                      <span className="block text-sm text-neutral-500">{API_KEY_SCOPE_DESCRIPTIONS[scope]}</span>
                    </span>
                  </label>
                ))}
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDraft(null)}>
              Cancel
            </Button>
            <Button onClick={create} disabled={saving || !draft?.name.trim() || draft.scopes.length === 0}>
              {saving ? 'Creating…' : 'Create key'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={secret !== null} onOpenChange={open => !open && setSecret(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Copy the key now</DialogTitle>
            <DialogDescription>It is shown this once. Plunk keeps only a hash of it.</DialogDescription>
          </DialogHeader>
          {/* min-w-0: the dialog is a grid, whose items would otherwise grow to the secret's full width. */}
          {secret && (
            <div className="min-w-0">
              <ApiKeyDisplay label="Secret" value={secret} />
            </div>
          )}
          <DialogFooter>
            <Button onClick={() => setSecret(null)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={open => !open && setRevoking(null)}
        onConfirm={revoke}
        title={`Revoke ${revoking?.name ?? 'this key'}?`}
        description="Requests with the key are refused from now on. What it made keeps its name."
        confirmText="Revoke key"
        variant="destructive"
      />
    </Card>
  );
}
