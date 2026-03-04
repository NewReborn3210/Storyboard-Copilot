import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type ChangeEvent,
  type DragEvent,
} from 'react';
import { Handle, Position, useViewport, type NodeProps } from '@xyflow/react';
import { Upload } from 'lucide-react';

import {
  DEFAULT_ASPECT_RATIO,
  type UploadImageNodeData,
} from '@/features/canvas/domain/canvasNodes';
import { canvasEventBus } from '@/features/canvas/application/canvasServices';
import {
  prepareNodeImage,
  readFileAsDataUrl,
  resolveImageDisplayUrl,
  shouldUseOriginalImageByZoom,
} from '@/features/canvas/application/imageData';
import { useCanvasStore } from '@/stores/canvasStore';

type UploadNodeProps = NodeProps & {
  id: string;
  data: UploadImageNodeData;
  selected?: boolean;
};

function toCssAspectRatio(aspectRatio: string): string {
  const [width = '1', height = '1'] = aspectRatio.split(':');
  return `${width} / ${height}`;
}

export const UploadNode = memo(({ id, data, selected }: UploadNodeProps) => {
  const setSelectedNode = useCanvasStore((state) => state.setSelectedNode);
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const { zoom } = useViewport();
  const inputRef = useRef<HTMLInputElement>(null);

  const processFile = useCallback(
    async (file: File) => {
      const tauriFilePath =
        (file as File & { path?: string }).path;
      const source =
        typeof tauriFilePath === 'string' && tauriFilePath.trim().length > 0
          ? tauriFilePath
          : await readFileAsDataUrl(file);

      const prepared = await prepareNodeImage(source);
      updateNodeData(id, {
        imageUrl: prepared.imageUrl,
        previewImageUrl: prepared.previewImageUrl,
        aspectRatio: prepared.aspectRatio || DEFAULT_ASPECT_RATIO,
      });
    },
    [id, updateNodeData]
  );

  const handleDrop = useCallback(
    async (event: DragEvent<HTMLElement>) => {
      event.preventDefault();
      const file = event.dataTransfer.files?.[0];
      if (!file || !file.type.startsWith('image/')) {
        return;
      }

      await processFile(file);
    },
    [processFile]
  );

  const handleFileChange = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file || !file.type.startsWith('image/')) {
        return;
      }

      await processFile(file);
      event.target.value = '';
    },
    [processFile]
  );

  useEffect(() => {
    return canvasEventBus.subscribe('upload-node/reupload', ({ nodeId }) => {
      if (nodeId !== id) {
        return;
      }
      inputRef.current?.click();
    });
  }, [id]);

  const handleNodeClick = useCallback(() => {
    setSelectedNode(id);
    if (!data.imageUrl) {
      inputRef.current?.click();
    }
  }, [data.imageUrl, id, setSelectedNode]);

  const imageSource = useMemo(() => {
    const preferOriginal = shouldUseOriginalImageByZoom(zoom);
    const picked = preferOriginal
      ? data.imageUrl || data.previewImageUrl
      : data.previewImageUrl || data.imageUrl;
    return picked ? resolveImageDisplayUrl(picked) : null;
  }, [data.imageUrl, data.previewImageUrl, zoom]);

  return (
    <div
      className={`
        w-[220px] rounded-[var(--node-radius)] border bg-surface-dark/85 p-0 transition-all duration-150
        ${selected
          ? 'border-accent shadow-[0_0_0_1px_rgba(59,130,246,0.32)]'
          : 'border-[rgba(255,255,255,0.22)] hover:border-[rgba(255,255,255,0.34)]'}
      `}
      onClick={handleNodeClick}
    >
      {data.imageUrl ? (
        <div
          className="block inset-0 overflow-hidden rounded-[var(--node-radius)] bg-bg-dark"
          style={{
            aspectRatio: toCssAspectRatio(data.aspectRatio || DEFAULT_ASPECT_RATIO),
          }}
        >
          <img
            src={imageSource ?? ''}
            alt="Uploaded"
            className="h-full w-full object-cover"
          />
        </div>
      ) : (
        <label
          className="block inset-0 overflow-hidden rounded-[var(--node-radius)] bg-bg-dark"
          style={{
            aspectRatio: toCssAspectRatio(data.aspectRatio || DEFAULT_ASPECT_RATIO),
          }}
          onDrop={handleDrop}
          onDragOver={(event) => event.preventDefault()}
        >
          <div className="flex h-full w-full cursor-pointer flex-col items-center justify-center gap-2 text-text-muted/85">
            <Upload className="h-7 w-7 opacity-60" />
            <span className="px-3 text-center text-[12px] leading-6">点击或拖拽上传图片</span>
          </div>
        </label>
      )}
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={handleFileChange}
      />

      <Handle
        type="source"
        position={Position.Right}
        className="!h-2 !w-2 !border-surface-dark !bg-accent"
      />
    </div>
  );
});

UploadNode.displayName = 'UploadNode';
