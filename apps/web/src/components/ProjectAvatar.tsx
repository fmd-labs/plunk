import {useRef, useState} from 'react';
import {Button, cn, Input} from '@plunk/ui';
import {ImageUp, Trash2} from 'lucide-react';
import {toast} from 'sonner';
import {useConfig} from '../lib/hooks/useConfig';
import {network} from '../lib/network';

interface ProjectAvatarProps {
  project: {name: string; avatarUrl?: string | null} | null | undefined;
  /** Size, corner radius and text size; a 24 px square by default. */
  className?: string;
}

/**
 * A project's avatar (fork D38): its image, or the first letter of its name without one or when the image fails to
 * load.
 */
export function ProjectAvatar({project, className = 'h-6 w-6 rounded-md text-xs'}: ProjectAvatarProps) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const url = project?.avatarUrl;
  const base = 'flex shrink-0 items-center justify-center overflow-hidden bg-neutral-100 font-medium text-neutral-700';

  if (url && url !== failedUrl) {
    return (
      // A plain img: the URL can point anywhere, which next/image would need configured host by host.
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={url}
        alt=""
        referrerPolicy="no-referrer"
        className={cn(base, 'object-cover', className)}
        onError={() => setFailedUrl(url)}
      />
    );
  }
  return <div className={cn(base, className)}>{project?.name.charAt(0).toUpperCase() || 'P'}</div>;
}

interface ProjectAvatarFieldProps {
  name: string;
  value: string | null | undefined;
  onChange: (avatarUrl: string) => void;
}

/** The avatar's field in the project settings (fork D38): an upload, where storage is set up, or any image URL. */
export function ProjectAvatarField({name, value, onChange}: ProjectAvatarFieldProps) {
  const {data: config} = useConfig();
  const canUpload = Boolean(config?.features.storage.s3Enabled);
  const fileInput = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  const upload = async (file: File) => {
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append('image', file);
      const {url} = await network.upload<{url: string}>('POST', '/uploads/image', formData);
      onChange(url);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Couldn’t upload the image. Try again.');
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="flex items-start gap-4">
      <ProjectAvatar project={{name: name || 'P', avatarUrl: value}} className="h-14 w-14 rounded-xl text-lg" />
      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex gap-2">
          <Input
            aria-label="Avatar image URL"
            placeholder="https://example.com/logo.png"
            value={value ?? ''}
            onChange={e => onChange(e.target.value)}
          />
          {canUpload && (
            <>
              <input
                ref={fileInput}
                type="file"
                accept="image/png,image/jpeg,image/gif,image/webp"
                className="hidden"
                onChange={e => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  if (file) void upload(file);
                }}
              />
              <Button
                type="button"
                variant="outline"
                disabled={uploading}
                onClick={() => fileInput.current?.click()}
              >
                <ImageUp className="h-4 w-4" />
                {uploading ? 'Uploading…' : 'Upload'}
              </Button>
            </>
          )}
          {value && (
            <Button type="button" variant="ghost" aria-label="Remove avatar" onClick={() => onChange('')}>
              <Trash2 className="h-4 w-4" />
            </Button>
          )}
        </div>
        <p className="text-sm text-neutral-500">
          Shown with the project’s name across the dashboard. A square PNG, JPEG, GIF or WebP works best.
        </p>
      </div>
    </div>
  );
}
