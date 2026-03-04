import {
  memo,
  useMemo,
  useState,
  useCallback,
  useEffect,
  useRef,
} from 'react';
import { Handle, Position } from '@xyflow/react';
import { ArrowUp, Minus, Plus, Sparkles } from 'lucide-react';

import {
  AUTO_REQUEST_ASPECT_RATIO,
  CANVAS_NODE_TYPES,
  DEFAULT_ASPECT_RATIO,
  type ImageSize,
  type StoryboardGenNodeData,
} from '@/features/canvas/domain/canvasNodes';
import { EXPORT_RESULT_DISPLAY_NAME, resolveNodeDisplayName } from '@/features/canvas/domain/nodeDisplay';
import { useCanvasStore } from '@/stores/canvasStore';
import { useSettingsStore } from '@/stores/settingsStore';
import {
  canvasAiGateway,
  graphImageResolver,
} from '@/features/canvas/application/canvasServices';
import {
  detectAspectRatio,
  prepareNodeImage,
  parseAspectRatio,
} from '@/features/canvas/application/imageData';
import {
  DEFAULT_IMAGE_MODEL_ID,
  getImageModel,
  listImageModels,
} from '@/features/canvas/models';
import { ModelParamsControls } from '@/features/canvas/ui/ModelParamsControls';
import {
  UiButton,
} from '@/components/ui';
import { NodeHeader, NODE_HEADER_FLOATING_POSITION_CLASS } from '@/features/canvas/ui/NodeHeader';

type StoryboardGenNodeProps = {
  id: string;
  data: StoryboardGenNodeData;
  selected?: boolean;
};

interface AspectRatioChoice {
  value: string;
  label: string;
}

const AUTO_ASPECT_RATIO_OPTION: AspectRatioChoice = {
  value: AUTO_REQUEST_ASPECT_RATIO,
  label: '自动',
};

const STORYBOARD_NODE_HORIZONTAL_PADDING_PX = 24;
const STORYBOARD_GRID_GAP_PX = 2;
const STORYBOARD_GRID_BASE_CELL_HEIGHT_PX = 78;
const STORYBOARD_GRID_MAX_WIDTH_PX = 320;
const STORYBOARD_CONTROL_ROW_WIDTH_PX = 274;
const STORYBOARD_GEN_HEADER_ADJUST = { x: 0, y: 0, scale: 1 };
const STORYBOARD_GEN_ICON_ADJUST = { x: 0, y: 0, scale: 0.95 };
const STORYBOARD_GEN_TITLE_ADJUST = { x: 0, y: 0, scale: 1 };
const GRID_CONTROL_CONTAINER_CLASS = 'flex h-5 items-center gap-0.5 rounded-full border border-[rgba(255,255,255,0.14)] bg-[rgba(255,255,255,0.04)] px-1';
const GRID_CONTROL_LABEL_CLASS = 'text-[9px] text-text-muted';
const GRID_CONTROL_BUTTON_CLASS = 'flex h-3 w-3 items-center justify-center rounded text-text-muted transition-colors hover:bg-white/10 hover:text-text-dark';
const GRID_CONTROL_ICON_CLASS = 'h-1.5 w-1.5';
const GRID_CONTROL_VALUE_CLASS = 'min-w-[14px] text-center text-[9px] font-semibold text-text-dark';
const GRID_SUMMARY_CLASS = 'flex h-5 items-center rounded-full border border-[rgba(255,255,255,0.14)] bg-[rgba(255,255,255,0.05)] px-1.5 text-[9px] text-text-muted';
const FRAME_GRID_GAP_PX = 2;
const CONTROL_ROW_HEIGHT_PX = 20;
const CONTROL_ROW_MARGIN_BOTTOM_PX = 10;
const FRAME_GRID_MARGIN_BOTTOM_PX = 8;
const PARAM_ROW_HEIGHT_PX = 20;
const NODE_VERTICAL_PADDING_PX = 24;

type GridStepperControlProps = {
  label: string;
  value: number;
  onDecrease: () => void;
  onIncrease: () => void;
};

function GridStepperControl({
  label,
  value,
  onDecrease,
  onIncrease,
}: GridStepperControlProps) {
  return (
    <div className={GRID_CONTROL_CONTAINER_CLASS}>
      <span className={GRID_CONTROL_LABEL_CLASS}>{label}</span>
      <button
        type="button"
        className={GRID_CONTROL_BUTTON_CLASS}
        onClick={(event) => {
          event.stopPropagation();
          onDecrease();
        }}
      >
        <Minus className={GRID_CONTROL_ICON_CLASS} />
      </button>
      <span className={GRID_CONTROL_VALUE_CLASS}>{value}</span>
      <button
        type="button"
        className={GRID_CONTROL_BUTTON_CLASS}
        onClick={(event) => {
          event.stopPropagation();
          onIncrease();
        }}
      >
        <Plus className={GRID_CONTROL_ICON_CLASS} />
      </button>
    </div>
  );
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

function generateFrameId(): string {
  return `frame-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

function toCssAspectRatio(aspectRatio: string): string {
  const [width = '1', height = '1'] = aspectRatio.split(':');
  return `${width} / ${height}`;
}

export const StoryboardGenNode = memo(({ id, data, selected }: StoryboardGenNodeProps) => {
  const setSelectedNode = useCanvasStore((state) => state.setSelectedNode);
  const nodes = useCanvasStore((state) => state.nodes);
  const edges = useCanvasStore((state) => state.edges);
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const addNode = useCanvasStore((state) => state.addNode);
  const addEdge = useCanvasStore((state) => state.addEdge);
  const findNodePosition = useCanvasStore((state) => state.findNodePosition);
  const apiKey = useSettingsStore((state) => state.apiKey);

  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const nodeData = data as StoryboardGenNodeData;
  const resolvedTitle = useMemo(
    () => resolveNodeDisplayName(CANVAS_NODE_TYPES.storyboardGen, nodeData),
    [nodeData]
  );

  const incomingImages = useMemo(
    () => graphImageResolver.collectInputImages(id, nodes, edges),
    [id, nodes, edges]
  );

  const imageModels = useMemo(() => listImageModels(), []);

  const selectedModel = useMemo(() => {
    const modelId = nodeData.model ?? DEFAULT_IMAGE_MODEL_ID;
    return getImageModel(modelId);
  }, [nodeData.model]);

  const selectedResolution = useMemo((): AspectRatioChoice => {
    const nodeSize = nodeData.size;
    const found = nodeSize ? selectedModel.resolutions.find((item) => item.value === nodeSize) : undefined;
    return found ?? selectedModel.resolutions.find((item) => item.value === selectedModel.defaultResolution) ?? selectedModel.resolutions[0];
  }, [nodeData.size, selectedModel]);

  const aspectRatioOptions = useMemo<AspectRatioChoice[]>(
    () => [AUTO_ASPECT_RATIO_OPTION, ...selectedModel.aspectRatios],
    [selectedModel.aspectRatios]
  );

  const selectedAspectRatio = useMemo((): AspectRatioChoice => {
    const nodeAspectRatio = nodeData.requestAspectRatio;
    const found = nodeAspectRatio ? aspectRatioOptions.find((item) => item.value === nodeAspectRatio) : undefined;
    return found ?? AUTO_ASPECT_RATIO_OPTION;
  }, [aspectRatioOptions, nodeData.requestAspectRatio]);

  const frameAspectRatioValue = useMemo(() => {
    if (selectedAspectRatio.value === AUTO_REQUEST_ASPECT_RATIO) {
      return nodeData.aspectRatio || DEFAULT_ASPECT_RATIO;
    }
    return selectedAspectRatio.value || DEFAULT_ASPECT_RATIO;
  }, [nodeData.aspectRatio, selectedAspectRatio.value]);

  const frameLayout = useMemo(() => {
    const aspectRatio = Math.max(0.1, parseAspectRatio(frameAspectRatioValue));
    let cellWidth = STORYBOARD_GRID_BASE_CELL_HEIGHT_PX * aspectRatio;
    let gridWidth = nodeData.gridCols * cellWidth + Math.max(0, nodeData.gridCols - 1) * STORYBOARD_GRID_GAP_PX;

    if (gridWidth > STORYBOARD_GRID_MAX_WIDTH_PX) {
      const scale = STORYBOARD_GRID_MAX_WIDTH_PX / gridWidth;
      cellWidth *= scale;
      gridWidth =
        nodeData.gridCols * cellWidth + Math.max(0, nodeData.gridCols - 1) * STORYBOARD_GRID_GAP_PX;
    }

    const roundedCellWidth = Math.max(24, Math.round(cellWidth));
    const roundedCellHeight = Math.max(16, Math.round(roundedCellWidth / aspectRatio));
    const roundedGridWidth =
      nodeData.gridCols * roundedCellWidth + Math.max(0, nodeData.gridCols - 1) * STORYBOARD_GRID_GAP_PX;
    const roundedGridHeight =
      nodeData.gridRows * roundedCellHeight + Math.max(0, nodeData.gridRows - 1) * FRAME_GRID_GAP_PX;
    const nodeInnerWidth = Math.max(STORYBOARD_CONTROL_ROW_WIDTH_PX, roundedGridWidth);
    const nodeWidth = Math.round(nodeInnerWidth + STORYBOARD_NODE_HORIZONTAL_PADDING_PX);
    const nodeHeight = Math.round(
      NODE_VERTICAL_PADDING_PX +
      CONTROL_ROW_HEIGHT_PX +
      CONTROL_ROW_MARGIN_BOTTOM_PX +
      roundedGridHeight +
      FRAME_GRID_MARGIN_BOTTOM_PX +
      PARAM_ROW_HEIGHT_PX
    );

    return {
      cellWidth: roundedCellWidth,
      gridWidth: roundedGridWidth,
      nodeWidth,
      nodeHeight,
      cellAspectRatio: toCssAspectRatio(frameAspectRatioValue),
    };
  }, [frameAspectRatioValue, nodeData.gridCols, nodeData.gridRows]);

  const requestResolution = selectedModel.resolveRequest({
    referenceImageCount: incomingImages.length,
  });

  const supportedAspectRatioValues = useMemo(
    () => selectedModel.aspectRatios.map((item) => item.value),
    [selectedModel.aspectRatios]
  );

  const totalFrames = useMemo(
    () => (nodeData.gridRows ?? 1) * (nodeData.gridCols ?? 1),
    [nodeData.gridRows, nodeData.gridCols]
  );

  // Sync model, size, aspect ratio with node data
  useEffect(() => {
    if (nodeData.model !== selectedModel.id) {
      updateNodeData(id, { model: selectedModel.id });
    }

    if (nodeData.size !== selectedResolution.value) {
      updateNodeData(id, { size: selectedResolution.value as ImageSize });
    }

    if (nodeData.requestAspectRatio !== selectedAspectRatio.value) {
      updateNodeData(id, { requestAspectRatio: selectedAspectRatio.value });
    }
  }, [
    id,
    nodeData,
    selectedModel.id,
    selectedResolution.value,
    selectedAspectRatio.value,
    updateNodeData,
  ]);

  // Auto-generate frames when grid changes
  useEffect(() => {
    const currentFrames = nodeData.frames;
    const targetCount = totalFrames;

    if (currentFrames.length === targetCount) {
      return;
    }

    const newFrames: StoryboardGenNodeData['frames'] = [];
    for (let i = 0; i < targetCount; i++) {
      if (i < currentFrames.length) {
        newFrames.push(currentFrames[i]);
      } else {
        newFrames.push({
          id: generateFrameId(),
          description: '',
          referenceIndex: null,
        });
      }
    }

    updateNodeData(id, { frames: newFrames });
  }, [id, nodeData.frames, totalFrames, updateNodeData]);

  // Build prompt from frames
  const buildPrompt = useCallback((): string => {
    if (!nodeData) {
      return '';
    }

    const { gridRows, gridCols, frames } = nodeData;
    const parts: string[] = [];

    parts.push(`生成一张${gridRows}×${gridCols}的${gridRows * gridCols}宫格分镜图`);

    frames.forEach((frame, index) => {
      if (!frame.description.trim()) {
        return;
      }

      let frameText = `分镜${index + 1}：${frame.description.trim()}`;
      if (frame.referenceIndex !== null && incomingImages[frame.referenceIndex]) {
        frameText += `，参考：图${frame.referenceIndex + 1}`;
      }
      parts.push(frameText);
    });

    return parts.join('\n');
  }, [nodeData, incomingImages]);

  const handleGenerate = useCallback(async () => {
    if (!nodeData) {
      return;
    }

    const prompt = buildPrompt();
    if (!prompt) {
      setError('请填写至少一个分镜内容描述');
      return;
    }

    if (!apiKey) {
      setError('请在设置中填写 API Key');
      return;
    }

    const generationDurationMs = selectedModel.expectedDurationMs ?? 60000;
    const generationStartedAt = Date.now();

    // Create new image node with generating state immediately
    // Use auto-positioning to avoid collisions with existing nodes
    const newNodePosition = findNodePosition(id, 220, 180);
    const newNodeId = addNode(
      CANVAS_NODE_TYPES.exportImage,
      newNodePosition,
      {
        isGenerating: true,
        generationStartedAt,
        generationDurationMs,
        displayName: EXPORT_RESULT_DISPLAY_NAME.storyboardGenOutput,
        resultKind: 'storyboardGenOutput',
        prompt: '',
        model: selectedModel.id,
        size: selectedResolution.value as ImageSize,
        requestAspectRatio: selectedAspectRatio.value,
      }
    );

    // Connect the storyboard node to the new image node
    addEdge(id, newNodeId);

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

      // Update the new image node with generated result
      updateNodeData(newNodeId, {
        imageUrl: prepared.imageUrl,
        previewImageUrl: prepared.previewImageUrl,
        aspectRatio: prepared.aspectRatio,
        isGenerating: false,
        generationStartedAt: null,
      });
    } catch (generationError) {
      setError(generationError instanceof Error ? generationError.message : '生成失败');
      // Clear generating state and mark as failed
      updateNodeData(newNodeId, {
        isGenerating: false,
        generationStartedAt: null,
      });
    }
  }, [
    apiKey,
    nodeData,
    incomingImages,
    requestResolution.requestModel,
    selectedModel.expectedDurationMs,
    supportedAspectRatioValues,
    setSelectedNode,
    selectedAspectRatio.value,
    selectedResolution.value,
    addNode,
    addEdge,
    buildPrompt,
    selectedModel.id,
    findNodePosition,
    updateNodeData,
  ]);

  const handleRowChange = useCallback(
    (delta: number) => {
      if (!nodeData) {
        return;
      }
      const newRows = Math.max(1, Math.min(9, nodeData.gridRows + delta));
      updateNodeData(id, { gridRows: newRows });
    },
    [nodeData, updateNodeData]
  );

  const handleColChange = useCallback(
    (delta: number) => {
      if (!nodeData) {
        return;
      }
      const newCols = Math.max(1, Math.min(9, nodeData.gridCols + delta));
      updateNodeData(id, { gridCols: newCols });
    },
    [nodeData, updateNodeData]
  );

  const handleFrameDescriptionChange = useCallback(
    (index: number, description: string) => {
      if (!nodeData) {
        return;
      }
      const newFrames = [...nodeData.frames];
      newFrames[index] = { ...newFrames[index], description };
      updateNodeData(id, { frames: newFrames });
    },
    [nodeData, updateNodeData]
  );

  if (!nodeData) {
    return null;
  }

  return (
    <div
      ref={rootRef}
      className={`
        relative overflow-visible rounded-[var(--node-radius)] border bg-surface-dark/95 p-3 transition-all duration-150
        ${selected
          ? 'border-accent shadow-[0_0_0_1px_rgba(59,130,246,0.32)]'
          : 'border-[rgba(255,255,255,0.22)] hover:border-[rgba(255,255,255,0.34)]'
        }
      `}
      style={{
        width: `${frameLayout.nodeWidth}px`,
        height: `${frameLayout.nodeHeight}px`,
      }}
      onClick={() => setSelectedNode(id)}
    >
      {/* Floating title */}
      <NodeHeader
        className={NODE_HEADER_FLOATING_POSITION_CLASS}
        icon={<Sparkles className="h-4 w-4" />}
        titleText={resolvedTitle}
        headerAdjust={STORYBOARD_GEN_HEADER_ADJUST}
        iconAdjust={STORYBOARD_GEN_ICON_ADJUST}
        titleAdjust={STORYBOARD_GEN_TITLE_ADJUST}
        editable
        onTitleChange={(nextTitle) => updateNodeData(id, { displayName: nextTitle })}
      />

      {/* Frame summary + grid settings */}
      <div className="mb-2.5 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <GridStepperControl
            label="行"
            value={nodeData.gridRows}
            onDecrease={() => handleRowChange(-1)}
            onIncrease={() => handleRowChange(1)}
          />
          <GridStepperControl
            label="列"
            value={nodeData.gridCols}
            onDecrease={() => handleColChange(-1)}
            onIncrease={() => handleColChange(1)}
          />
        </div>

        <div className={GRID_SUMMARY_CLASS}>
          {totalFrames} 格
        </div>
      </div>

      {/* Frame Grid */}
      <div className="mb-2 flex justify-center">
        <div
          className="grid gap-0.5"
          style={{
            width: `${frameLayout.gridWidth}px`,
            gridTemplateColumns: `repeat(${nodeData.gridCols}, ${frameLayout.cellWidth}px)`,
          }}
        >
          {nodeData.frames.map((frame, index) => (
            <div
              key={frame.id}
              className="relative overflow-hidden rounded border border-[rgba(255,255,255,0.06)] bg-bg-dark/40"
              style={{ aspectRatio: frameLayout.cellAspectRatio }}
            >
              <textarea
                value={frame.description}
                onChange={(e) => handleFrameDescriptionChange(index, e.target.value)}
                placeholder="..."
                wrap="soft"
                className="ui-scrollbar nodrag nowheel absolute inset-0 h-full w-full resize-none overflow-y-auto overflow-x-hidden bg-transparent px-1.5 py-1 text-left text-[10px] leading-4 text-text-dark placeholder:text-text-muted/40 focus:border-accent/50 focus:outline-none whitespace-pre-wrap break-words"
              />
            </div>
          ))}
        </div>
      </div>

      {/* AI Parameters */}
      <div className="relative mx-auto flex w-[280px] items-center justify-between">
        <ModelParamsControls
          imageModels={imageModels}
          selectedModel={selectedModel}
          selectedResolution={selectedResolution}
          selectedAspectRatio={selectedAspectRatio}
          aspectRatioOptions={aspectRatioOptions}
          onModelChange={(modelId) => updateNodeData(id, { model: modelId })}
          onResolutionChange={(resolution) =>
            updateNodeData(id, { size: resolution as ImageSize })
          }
          onAspectRatioChange={(aspectRatio) =>
            updateNodeData(id, { requestAspectRatio: aspectRatio })
          }
          triggerSize="sm"
          chipClassName="!h-5 !gap-1 !rounded-md !px-1.5 !text-[11px]"
          modelChipClassName="!w-[160px] !justify-start"
          paramsChipClassName="!w-[78px] !justify-start"
          modelPanelAlign="center"
          paramsPanelAlign="center"
          modelPanelClassName="w-[360px] p-2"
          paramsPanelClassName="w-[420px] p-3"
        />

        <UiButton
          onClick={(e) => { e.stopPropagation(); handleGenerate(); }}
          variant="primary"
          size="sm"
          className="!h-5 !w-5 !min-w-0 shrink-0 !rounded-md !p-0"
        >
          <ArrowUp className="h-2.5 w-2.5" strokeWidth={2.8} />
        </UiButton>
      </div>

      {error && <div className="mt-2 text-[10px] text-red-400">{error}</div>}

      <Handle
        type="target"
        position={Position.Left}
        className="!h-2 !w-2 !border-surface-dark !bg-accent"
      />
      <Handle
        type="source"
        position={Position.Right}
        className="!h-2 !w-2 !border-surface-dark !bg-accent"
      />
    </div>
  );
});

StoryboardGenNode.displayName = 'StoryboardGenNode';
