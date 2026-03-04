import {
  type KeyboardEvent,
  type ReactNode,
  memo,
  useMemo,
  useState,
  useCallback,
  useEffect,
  useRef,
} from 'react';
import { NodeToolbar as ReactFlowNodeToolbar, Position } from '@xyflow/react';
import {
  ArrowUp,
} from 'lucide-react';

import {
  AUTO_REQUEST_ASPECT_RATIO,
  isImageEditNode,
  type ImageSize,
  type CanvasNode,
} from '@/features/canvas/domain/canvasNodes';
import {
  canvasAiGateway,
  graphImageResolver,
} from '@/features/canvas/application/canvasServices';
import {
  detectAspectRatio,
  prepareNodeImage,
  parseAspectRatio,
  resolveImageDisplayUrl,
} from '@/features/canvas/application/imageData';
import {
  DEFAULT_IMAGE_MODEL_ID,
  getImageModel,
  listImageModels,
} from '@/features/canvas/models';
import { useCanvasStore } from '@/stores/canvasStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { ModelParamsControls } from './ModelParamsControls';
import {
  UiButton,
  UiPanel,
} from '@/components/ui';

interface NodePromptInputProps {
  node: CanvasNode;
}

interface AspectRatioChoice {
  value: string;
  label: string;
}

interface PickerAnchor {
  left: number;
  top: number;
}

const AUTO_ASPECT_RATIO_OPTION: AspectRatioChoice = {
  value: AUTO_REQUEST_ASPECT_RATIO,
  label: '自动',
};

const IMAGE_REFERENCE_MARKER_REGEX = /@图\d+/g;
const PICKER_FALLBACK_ANCHOR: PickerAnchor = { left: 8, top: 8 };
const PICKER_Y_OFFSET_PX = 20;

function getTextareaCaretOffset(
  textarea: HTMLTextAreaElement,
  caretIndex: number
): PickerAnchor {
  const mirror = document.createElement('div');
  const computed = window.getComputedStyle(textarea);
  const mirrorStyle = mirror.style;

  mirrorStyle.position = 'absolute';
  mirrorStyle.visibility = 'hidden';
  mirrorStyle.pointerEvents = 'none';
  mirrorStyle.whiteSpace = 'pre-wrap';
  mirrorStyle.overflowWrap = 'break-word';
  mirrorStyle.wordBreak = 'break-word';
  mirrorStyle.boxSizing = computed.boxSizing;
  mirrorStyle.width = `${textarea.clientWidth}px`;
  mirrorStyle.font = computed.font;
  mirrorStyle.lineHeight = computed.lineHeight;
  mirrorStyle.letterSpacing = computed.letterSpacing;
  mirrorStyle.padding = computed.padding;
  mirrorStyle.border = computed.border;
  mirrorStyle.textTransform = computed.textTransform;
  mirrorStyle.textIndent = computed.textIndent;

  mirror.textContent = textarea.value.slice(0, caretIndex);

  const marker = document.createElement('span');
  marker.textContent = textarea.value.slice(caretIndex, caretIndex + 1) || ' ';
  mirror.appendChild(marker);

  document.body.appendChild(mirror);

  const left = marker.offsetLeft - textarea.scrollLeft;
  const top = marker.offsetTop - textarea.scrollTop;

  document.body.removeChild(mirror);

  return {
    left: Math.max(0, left),
    top: Math.max(0, top),
  };
}

function resolvePickerAnchor(
  container: HTMLDivElement | null,
  textarea: HTMLTextAreaElement,
  caretIndex: number
): PickerAnchor {
  if (!container) {
    return PICKER_FALLBACK_ANCHOR;
  }

  const containerRect = container.getBoundingClientRect();
  const textareaRect = textarea.getBoundingClientRect();
  const caretOffset = getTextareaCaretOffset(textarea, caretIndex);

  return {
    left: Math.max(0, textareaRect.left - containerRect.left + caretOffset.left),
    top: Math.max(0, textareaRect.top - containerRect.top + caretOffset.top + PICKER_Y_OFFSET_PX),
  };
}

function renderPromptWithHighlights(prompt: string): ReactNode {
  if (!prompt) {
    return ' ';
  }

  const segments: ReactNode[] = [];
  let lastIndex = 0;
  IMAGE_REFERENCE_MARKER_REGEX.lastIndex = 0;
  let match = IMAGE_REFERENCE_MARKER_REGEX.exec(prompt);
  while (match) {
    const matchStart = match.index;
    const matchText = match[0];

    if (matchStart > lastIndex) {
      segments.push(
        <span key={`plain-${lastIndex}`}>{prompt.slice(lastIndex, matchStart)}</span>
      );
    }

    segments.push(
      <span key={`ref-${matchStart}`} className="font-semibold text-accent">
        {matchText}
      </span>
    );

    lastIndex = matchStart + matchText.length;
    match = IMAGE_REFERENCE_MARKER_REGEX.exec(prompt);
  }

  if (lastIndex < prompt.length) {
    segments.push(<span key={`plain-${lastIndex}`}>{prompt.slice(lastIndex)}</span>);
  }

  return segments;
}

function pickClosestAspectRatio(
  targetRatio: number,
  supportedAspectRatios: string[]
): string {
  const supported = supportedAspectRatios.length > 0 ? supportedAspectRatios : ['1:1'];
  let bestValue = supported[0];
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const aspectRatio of supported) {
    const ratio = parseAspectRatio(aspectRatio);
    const distance = Math.abs(Math.log(ratio / targetRatio));
    if (distance < bestDistance) {
      bestDistance = distance;
      bestValue = aspectRatio;
    }
  }

  return bestValue;
}

export const NodePromptInput = memo(({ node }: NodePromptInputProps) => {
  const [error, setError] = useState<string | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const promptHighlightRef = useRef<HTMLDivElement>(null);
  const [showImagePicker, setShowImagePicker] = useState(false);
  const [pickerCursor, setPickerCursor] = useState<number | null>(null);
  const [pickerActiveIndex, setPickerActiveIndex] = useState(0);
  const [pickerAnchor, setPickerAnchor] = useState<PickerAnchor>(PICKER_FALLBACK_ANCHOR);

  const nodes = useCanvasStore((state) => state.nodes);
  const edges = useCanvasStore((state) => state.edges);
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const setSelectedNode = useCanvasStore((state) => state.setSelectedNode);
  const apiKey = useSettingsStore((state) => state.apiKey);

  const imageEditNode = isImageEditNode(node) ? node : null;

  const incomingImages = useMemo(
    () => graphImageResolver.collectInputImages(imageEditNode?.id ?? '', nodes, edges),
    [imageEditNode?.id, nodes, edges]
  );

  const incomingImageItems = useMemo(
    () =>
      incomingImages.map((imageUrl, index) => ({
        imageUrl,
        displayUrl: resolveImageDisplayUrl(imageUrl),
        label: `图${index + 1}`,
      })),
    [incomingImages]
  );

  const imageModels = useMemo(() => listImageModels(), []);

  const selectedModel = useMemo(() => {
    const modelId = imageEditNode?.data.model ?? DEFAULT_IMAGE_MODEL_ID;
    return getImageModel(modelId);
  }, [imageEditNode?.data.model]);

  const selectedResolution = useMemo(
    () =>
      selectedModel.resolutions.find((item) => item.value === imageEditNode?.data.size) ??
      selectedModel.resolutions.find((item) => item.value === selectedModel.defaultResolution) ??
      selectedModel.resolutions[0],
    [imageEditNode?.data.size, selectedModel]
  );

  const aspectRatioOptions = useMemo<AspectRatioChoice[]>(
    () => [AUTO_ASPECT_RATIO_OPTION, ...selectedModel.aspectRatios],
    [selectedModel.aspectRatios]
  );

  const selectedAspectRatio = useMemo(
    () =>
      aspectRatioOptions.find((item) => item.value === imageEditNode?.data.requestAspectRatio) ??
      AUTO_ASPECT_RATIO_OPTION,
    [aspectRatioOptions, imageEditNode?.data.requestAspectRatio]
  );

  const requestResolution = selectedModel.resolveRequest({
    referenceImageCount: incomingImages.length,
  });

  const supportedAspectRatioValues = useMemo(
    () => selectedModel.aspectRatios.map((item) => item.value),
    [selectedModel.aspectRatios]
  );

  useEffect(() => {
    if (!imageEditNode) {
      return;
    }

    if (imageEditNode.data.model !== selectedModel.id) {
      updateNodeData(imageEditNode.id, { model: selectedModel.id });
    }

    if (imageEditNode.data.size !== selectedResolution.value) {
      updateNodeData(imageEditNode.id, { size: selectedResolution.value as ImageSize });
    }

    if (imageEditNode.data.requestAspectRatio !== selectedAspectRatio.value) {
      updateNodeData(imageEditNode.id, { requestAspectRatio: selectedAspectRatio.value });
    }
  }, [
    imageEditNode,
    selectedModel.id,
    selectedResolution.value,
    selectedAspectRatio.value,
    updateNodeData,
  ]);

  useEffect(() => {
    if (incomingImages.length === 0) {
      setShowImagePicker(false);
      setPickerCursor(null);
      setPickerActiveIndex(0);
      return;
    }

    setPickerActiveIndex((previous) => Math.min(previous, incomingImages.length - 1));
  }, [incomingImages.length]);

  useEffect(() => {
    const handleOutside = (event: MouseEvent) => {
      if (containerRef.current?.contains(event.target as globalThis.Node)) {
        return;
      }

      setShowImagePicker(false);
      setPickerCursor(null);
    };

    document.addEventListener('mousedown', handleOutside, true);
    return () => {
      document.removeEventListener('mousedown', handleOutside, true);
    };
  }, []);

  const handleGenerate = useCallback(async () => {
    if (!imageEditNode) {
      return;
    }
    if (imageEditNode.data.isGenerating) {
      return;
    }

    const prompt = imageEditNode.data.prompt.replace(/@(?=图\d+)/g, '').trim();
    if (!prompt) {
      setError('请输入提示词');
      return;
    }

    if (!apiKey) {
      setError('请在设置中填写 API Key');
      return;
    }

    const generationDurationMs = selectedModel.expectedDurationMs ?? 60000;
    updateNodeData(imageEditNode.id, {
      isGenerating: true,
      generationStartedAt: Date.now(),
      generationDurationMs,
    });
    setSelectedNode(null);
    setError(null);

    try {
      await canvasAiGateway.setApiKey('ppio', apiKey);

      let resolvedRequestAspectRatio = selectedAspectRatio.value;
      if (resolvedRequestAspectRatio === AUTO_REQUEST_ASPECT_RATIO) {
        if (incomingImages.length > 0) {
          try {
            const sourceAspectRatio = await detectAspectRatio(incomingImages[0]);
            const sourceAspectRatioValue = parseAspectRatio(sourceAspectRatio);
            resolvedRequestAspectRatio = pickClosestAspectRatio(
              sourceAspectRatioValue,
              supportedAspectRatioValues
            );
          } catch {
            resolvedRequestAspectRatio = pickClosestAspectRatio(1, supportedAspectRatioValues);
          }
        } else {
          resolvedRequestAspectRatio = pickClosestAspectRatio(1, supportedAspectRatioValues);
        }
      }

      const resultUrl = await canvasAiGateway.generateImage({
        prompt,
        model: requestResolution.requestModel,
        size: selectedResolution.value,
        aspectRatio: resolvedRequestAspectRatio,
        referenceImages: incomingImages,
      });

      const prepared = await prepareNodeImage(resultUrl);

      updateNodeData(imageEditNode.id, {
        imageUrl: prepared.imageUrl,
        previewImageUrl: prepared.previewImageUrl,
        aspectRatio: prepared.aspectRatio,
        requestAspectRatio: selectedAspectRatio.value,
        isGenerating: false,
        generationStartedAt: null,
      });
    } catch (generationError) {
      setError(generationError instanceof Error ? generationError.message : '生成失败');
      updateNodeData(imageEditNode.id, {
        isGenerating: false,
        generationStartedAt: null,
      });
    }
  }, [
    apiKey,
    imageEditNode,
    incomingImages,
    requestResolution.requestModel,
    selectedModel.expectedDurationMs,
    supportedAspectRatioValues,
    setSelectedNode,
    selectedAspectRatio.value,
    selectedResolution.value,
    updateNodeData,
  ]);

  if (!imageEditNode) {
    return null;
  }

  const syncPromptHighlightScroll = () => {
    if (!promptRef.current || !promptHighlightRef.current) {
      return;
    }

    promptHighlightRef.current.scrollTop = promptRef.current.scrollTop;
    promptHighlightRef.current.scrollLeft = promptRef.current.scrollLeft;
  };

  const handlePromptKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (showImagePicker && incomingImages.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setPickerActiveIndex((previous) => (previous + 1) % incomingImages.length);
        return;
      }

      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setPickerActiveIndex((previous) =>
          previous === 0 ? incomingImages.length - 1 : previous - 1
        );
        return;
      }

      if (event.key === 'Enter') {
        event.preventDefault();
        insertImageReference(pickerActiveIndex);
        return;
      }
    }

    if (event.key === '@' && incomingImages.length > 0) {
      event.preventDefault();
      const cursor = event.currentTarget.selectionStart ?? imageEditNode.data.prompt.length;
      setPickerAnchor(resolvePickerAnchor(containerRef.current, event.currentTarget, cursor));
      setPickerCursor(cursor);
      setShowImagePicker(true);
      setPickerActiveIndex(0);
      return;
    }

    if (event.key === 'Escape' && showImagePicker) {
      event.preventDefault();
      setShowImagePicker(false);
      setPickerCursor(null);
      setPickerActiveIndex(0);
    }
  };

  const insertImageReference = (imageIndex: number) => {
    const marker = `@图${imageIndex + 1}`;
    const currentPrompt = imageEditNode.data.prompt;
    const cursor = pickerCursor ?? currentPrompt.length;
    const nextPrompt = `${currentPrompt.slice(0, cursor)}${marker}${currentPrompt.slice(cursor)}`;

    updateNodeData(imageEditNode.id, { prompt: nextPrompt });
    setShowImagePicker(false);
    setPickerCursor(null);
    setPickerActiveIndex(0);

    const nextCursor = cursor + marker.length;
    requestAnimationFrame(() => {
      promptRef.current?.focus();
      promptRef.current?.setSelectionRange(nextCursor, nextCursor);
      syncPromptHighlightScroll();
    });
  };

  return (
    <ReactFlowNodeToolbar
      nodeId={imageEditNode.id}
      isVisible
      position={Position.Bottom}
      align="center"
      offset={14}
      className="pointer-events-auto"
    >
      <div ref={containerRef} className="relative">
        <UiPanel className="w-[540px] p-2">
          <div className="relative h-32">
            <div
              ref={promptHighlightRef}
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 overflow-auto text-sm leading-7 text-text-dark [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            >
              <div className="min-h-full whitespace-pre-wrap break-words px-1 py-1.5">
                {renderPromptWithHighlights(imageEditNode.data.prompt)}
              </div>
            </div>

            <textarea
              ref={promptRef}
              value={imageEditNode.data.prompt}
              onChange={(event) => updateNodeData(imageEditNode.id, { prompt: event.target.value })}
              onKeyDown={handlePromptKeyDown}
              onScroll={syncPromptHighlightScroll}
              placeholder="描述任何你想要生成或编辑的内容"
              className="relative z-10 h-full w-full resize-none border-none bg-transparent px-1 py-1.5 text-sm leading-7 text-transparent caret-text-dark outline-none placeholder:text-text-muted/80 focus:border-transparent"
            />
          </div>

          {showImagePicker && incomingImageItems.length > 0 && (
            <div
              className="absolute z-30 w-[15%] min-w-[60px] overflow-hidden rounded-xl border border-[rgba(255,255,255,0.16)] bg-surface-dark shadow-xl"
              style={{ left: pickerAnchor.left, top: pickerAnchor.top }}
            >
              <div className="ui-scrollbar max-h-[180px] overflow-y-auto">
                {incomingImageItems.map((item, index) => (
                  <button
                    key={`${item.imageUrl}-${index}`}
                    type="button"
                    onClick={() => insertImageReference(index)}
                    onMouseEnter={() => setPickerActiveIndex(index)}
                    className={`flex w-full items-center gap-2 border border-transparent bg-bg-dark/70 px-2 py-2 text-left text-sm text-text-dark transition-colors hover:border-[rgba(255,255,255,0.18)] ${pickerActiveIndex === index
                      ? 'border-[rgba(255,255,255,0.24)] bg-bg-dark'
                      : ''
                      }`}
                  >
                    <img
                      src={item.displayUrl}
                      alt={item.label}
                      className="h-8 w-8 rounded object-cover"
                    />
                    <span>{item.label}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="mt-1 flex items-center gap-1">
            <ModelParamsControls
              imageModels={imageModels}
              selectedModel={selectedModel}
              selectedResolution={selectedResolution}
              selectedAspectRatio={selectedAspectRatio}
              aspectRatioOptions={aspectRatioOptions}
              onModelChange={(modelId) => updateNodeData(imageEditNode.id, { model: modelId })}
              onResolutionChange={(resolution) =>
                updateNodeData(imageEditNode.id, { size: resolution as ImageSize })
              }
              onAspectRatioChange={(aspectRatio) =>
                updateNodeData(imageEditNode.id, { requestAspectRatio: aspectRatio })
              }
            />

            <div className="ml-auto" />

            <UiButton
              onClick={handleGenerate}
              variant="primary"
              className="h-10 w-10 rounded-full px-0"
            >
              <ArrowUp className="h-5 w-5" strokeWidth={2.8} />
            </UiButton>
          </div>

          {error && <div className="mt-2 text-xs text-red-400">{error}</div>}
        </UiPanel>

      </div>
    </ReactFlowNodeToolbar>
  );
});

NodePromptInput.displayName = 'NodePromptInput';
