import {useRef, useState} from 'react';
import type {ControllerRenderProps} from 'react-hook-form';
import {Button, cn, FormControl, FormDescription, Input} from '@plunk/ui';
import {ImageUp, Trash2} from 'lucide-react';
import {toast} from 'sonner';
import {useConfig} from '../lib/hooks/useConfig';
import {network} from '../lib/network';

/** Avatar URLs that failed to load, kept across pages so a broken image isn't fetched again on every one. */
const failedUrls = new Set<string>();

/** Whether a value is worth showing as an image yet: an absolute http(s) URL, not a half-typed one. */
const isImageUrl = (value: string | null | undefined): value is string =>
  Boolean(value && /^https?:\/\/[^/\s]+\.[^/\s]+/i.test(value));

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
  const [, setFailures] = useState(0);
  const url = project?.avatarUrl;
  const base = 'flex shrink-0 items-center justify-center overflow-hidden bg-neutral-100 font-medium text-neutral-700';

  if (isImageUrl(url) && !failedUrls.has(url)) {
    return (
      // A plain img: the URL can point anywhere, which next/image would need configured host by host.
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={url}
        alt=""
        referrerPolicy="no-referrer"
        className={cn(base, 'object-cover', className)}
        onError={() => {
          failedUrls.add(url);
          setFailures(count => count + 1);
        }}
      />
    );
  }
  return <div className={cn(base, className)}>{project?.name.charAt(0).toUpperCase() || 'P'}</div>;
}

const UPLOAD_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const UPLOAD_MAX_BYTES = 10 * 1024 * 1024;

interface ProjectAvatarFieldProps {
  /** The project's name, for the initial the preview falls back to. */
  name: string;
  field: ControllerRenderProps<{avatarUrl?: string | null}, 'avatarUrl'>;
}

/**
 * The avatar's field in the project settings (fork D38), inside its `FormItem`: an upload, where storage is set up,
 * or any image URL. Either takes effect with the form's save.
 */
export function ProjectAvatarField({name, field}: ProjectAvatarFieldProps) {
  const {data: config} = useConfig();
  const canUpload = Boolean(config?.features.storage.s3Enabled);
  const fileInput = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  const upload = async (file: File) => {
    if (!UPLOAD_TYPES.includes(file.type)) {
      toast.error('Choose a PNG, JPEG, GIF or WebP image');
      return;
    }
    if (file.size > UPLOAD_MAX_BYTES) {
      toast.error('Choose an image of 10 MB or less');
      return;
    }
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append('image', file);
      const {url} = await network.upload<{url: string}>('POST', '/uploads/image', formData);
      field.onChange(url);
      toast.success('Uploaded. Save the settings to use it.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Couldn’t upload the image. Try again.');
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="flex items-start gap-4">
      <ProjectAvatar project={{name: name || 'P', avatarUrl: field.value}} className="h-14 w-14 rounded-xl text-lg" />
      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex flex-wrap gap-2">
          <FormControl>
            <Input
              ref={field.ref}
              name={field.name}
              onBlur={field.onBlur}
              className="min-w-0 basis-full sm:basis-0 sm:flex-1"
              placeholder="https://example.com/logo.png"
              value={field.value ?? ''}
              onChange={e => field.onChange(e.target.value)}
            />
          </FormControl>
          {canUpload && (
            <>
              <input
                ref={fileInput}
                type="file"
                accept={UPLOAD_TYPES.join(',')}
                className="hidden"
                onChange={e => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  if (file) void upload(file);
                }}
              />
              <Button type="button" variant="outline" disabled={uploading} onClick={() => fileInput.current?.click()}>
                <ImageUp className="h-4 w-4" />
                {uploading ? 'Uploading…' : 'Upload'}
              </Button>
            </>
          )}
          {field.value && (
            <Button type="button" variant="ghost" aria-label="Remove avatar" onClick={() => field.onChange('')}>
              <Trash2 className="h-4 w-4" />
            </Button>
          )}
        </div>
        <FormDescription className="text-sm">
          Shown with the project’s name across the dashboard. A square PNG, JPEG, GIF or WebP works best.
        </FormDescription>
      </div>
    </div>
  );
}
