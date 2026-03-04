import {
  NODE_TOOL_TYPES,
  type NodeToolType,
  type StoryboardFrameItem,
} from '../domain/canvasNodes';
import {
  canvasToDataUrl,
  detectAspectRatio,
  loadImageElement,
  parseAspectRatio,
  persistImageLocally,
} from './imageData';
import { cropImageSource } from '@/commands/image';
import { drawAnnotations, parseAnnotationItems } from '../tools/annotation';
import type {
  IdGenerator,
  ImageSplitGateway,
  ToolProcessor,
  ToolProcessorResult,
} from './ports';

export class CanvasToolProcessor implements ToolProcessor {
  constructor(
    private readonly splitGateway: ImageSplitGateway,
    private readonly idGenerator: IdGenerator
  ) {}

  async process(
    toolType: NodeToolType,
    sourceImageUrl: string,
    options: Record<string, unknown>
  ): Promise<ToolProcessorResult> {
    if (toolType === NODE_TOOL_TYPES.splitStoryboard) {
      return await this.splitStoryboard(
        sourceImageUrl,
        Number(options.rows ?? 3),
        Number(options.cols ?? 3),
        Number(options.lineThickness ?? 0)
      );
    }

    switch (toolType) {
      case NODE_TOOL_TYPES.crop:
        return {
          outputImageUrl: await this.cropImage(sourceImageUrl, options),
        };
      case NODE_TOOL_TYPES.annotate:
        // Keep annotate on frontend for now because it supports free-form vector annotations.
        // Prefer local source first to avoid CORS taint and repeated remote fetches.
        return {
          outputImageUrl: await this.annotateImage(
            await persistImageLocally(sourceImageUrl),
            options
          ),
        };
      default:
        throw new Error('不支持的工具类型');
    }
  }

  private async cropImage(sourceImage: string, options: Record<string, unknown>): Promise<string> {
    try {
      return await cropImageSource({
        source: sourceImage,
        aspectRatio: String(options.aspectRatio ?? '1:1'),
        cropX: Number(options.cropX),
        cropY: Number(options.cropY),
        cropWidth: Number(options.cropWidth),
        cropHeight: Number(options.cropHeight),
      });
    } catch {
      // Fallback to local canvas implementation when backend command is unavailable.
    }

    const aspectRatio = String(options.aspectRatio ?? '1:1');
    const targetRatio = parseAspectRatio(aspectRatio);
    const image = await loadImageElement(sourceImage);

    const cropX = Number(options.cropX);
    const cropY = Number(options.cropY);
    const cropWidthOption = Number(options.cropWidth);
    const cropHeightOption = Number(options.cropHeight);

    const hasManualCropArea =
      Number.isFinite(cropX) &&
      Number.isFinite(cropY) &&
      Number.isFinite(cropWidthOption) &&
      Number.isFinite(cropHeightOption) &&
      cropWidthOption > 0 &&
      cropHeightOption > 0;

    let cropWidth = image.naturalWidth;
    let cropHeight = image.naturalHeight;
    let offsetX = 0;
    let offsetY = 0;

    if (hasManualCropArea) {
      offsetX = Math.min(image.naturalWidth - 1, Math.max(0, Math.floor(cropX)));
      offsetY = Math.min(image.naturalHeight - 1, Math.max(0, Math.floor(cropY)));
      cropWidth = Math.max(1, Math.min(Math.floor(cropWidthOption), image.naturalWidth - offsetX));
      cropHeight = Math.max(1, Math.min(Math.floor(cropHeightOption), image.naturalHeight - offsetY));
    } else if (aspectRatio === 'free') {
      offsetX = 0;
      offsetY = 0;
      cropWidth = image.naturalWidth;
      cropHeight = image.naturalHeight;
    } else {
      const sourceRatio = image.naturalWidth / image.naturalHeight;
      if (sourceRatio > targetRatio) {
        cropWidth = image.naturalHeight * targetRatio;
      } else {
        cropHeight = image.naturalWidth / targetRatio;
      }

      offsetX = (image.naturalWidth - cropWidth) / 2;
      offsetY = (image.naturalHeight - cropHeight) / 2;
    }

    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.floor(cropWidth));
    canvas.height = Math.max(1, Math.floor(cropHeight));

    const context = canvas.getContext('2d');
    if (!context) {
      throw new Error('无法初始化画布');
    }

    context.drawImage(
      image,
      offsetX,
      offsetY,
      cropWidth,
      cropHeight,
      0,
      0,
      canvas.width,
      canvas.height
    );

    return canvasToDataUrl(canvas);
  }

  private async annotateImage(
    sourceImage: string,
    options: Record<string, unknown>
  ): Promise<string> {
    const image = await loadImageElement(sourceImage);
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;

    const context = canvas.getContext('2d');
    if (!context) {
      throw new Error('无法初始化画布');
    }

    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const annotations = parseAnnotationItems(options.annotations);

    if (annotations.length > 0) {
      drawAnnotations(context, annotations);
    } else {
      const text = String(options.text ?? '').trim();
      const position = String(options.position ?? 'bottom');
      const color = String(options.color ?? '#FFFFFF');

      if (!text) {
        return canvasToDataUrl(canvas);
      }

      const fontSize = Math.max(24, Math.round(canvas.width * 0.04));
      context.font = `600 ${fontSize}px sans-serif`;
      context.textAlign = 'center';
      context.textBaseline = 'middle';

      const textWidth = context.measureText(text).width;
      const paddingX = Math.round(fontSize * 0.8);
      const paddingY = Math.round(fontSize * 0.6);
      const boxWidth = textWidth + paddingX * 2;
      const boxHeight = fontSize + paddingY * 2;

      const x = canvas.width / 2;
      const y = this.resolveAnnotateY(position, canvas.height, boxHeight);

      context.fillStyle = 'rgba(0, 0, 0, 0.45)';
      context.fillRect(x - boxWidth / 2, y - boxHeight / 2, boxWidth, boxHeight);
      context.fillStyle = color;
      context.fillText(text, x, y);
    }

    return canvasToDataUrl(canvas);
  }

  private resolveAnnotateY(position: string, canvasHeight: number, boxHeight: number): number {
    if (position === 'top') {
      return boxHeight / 2 + 24;
    }

    if (position === 'center') {
      return canvasHeight / 2;
    }

    return canvasHeight - boxHeight / 2 - 24;
  }

  private async splitStoryboard(
    sourceImage: string,
    rows: number,
    cols: number,
    lineThickness: number
  ): Promise<ToolProcessorResult> {
    const normalizedRows = Number.isFinite(rows) ? rows : 3;
    const normalizedCols = Number.isFinite(cols) ? cols : 3;
    const normalizedLineThickness = Number.isFinite(lineThickness) ? lineThickness : 0;

    const safeRows = Math.max(1, Math.floor(normalizedRows));
    const safeCols = Math.max(1, Math.floor(normalizedCols));
    const safeLineThickness = Math.max(0, Math.floor(normalizedLineThickness));

    if (safeRows <= 0 || safeCols <= 0) {
      throw new Error('分镜行列必须大于 0');
    }

    let outputs: string[];
    try {
      outputs = await this.splitGateway.split(
        sourceImage,
        safeRows,
        safeCols,
        safeLineThickness
      );
    } catch {
      // Fallback when Tauri command is unavailable or fails.
      outputs = await this.localSplit(sourceImage, safeRows, safeCols, safeLineThickness);
    }

    const persistedFrameImages = await Promise.all(
      outputs.map(async (imageUrl) => await persistImageLocally(imageUrl))
    );

    let frameAspectRatio: string | undefined;
    const firstFrameImage = persistedFrameImages[0];
    if (firstFrameImage) {
      try {
        frameAspectRatio = await detectAspectRatio(firstFrameImage);
      } catch {
        frameAspectRatio = undefined;
      }
    }

    const resolvedFrameAspectRatio = frameAspectRatio ?? `${safeCols}:${safeRows}`;
    const frames: StoryboardFrameItem[] = persistedFrameImages.map((imageUrl, index) => ({
      id: this.idGenerator.next(),
      imageUrl,
      previewImageUrl: imageUrl,
      aspectRatio: resolvedFrameAspectRatio,
      note: '',
      order: index,
    }));

    return {
      storyboardFrames: frames,
      rows: safeRows,
      cols: safeCols,
      frameAspectRatio: resolvedFrameAspectRatio,
    };
  }

  private splitIntoSegments(totalSize: number, segmentCount: number): number[] {
    const baseSize = Math.floor(totalSize / segmentCount);
    const remainder = totalSize % segmentCount;

    return Array.from(
      { length: segmentCount },
      (_item, index) => baseSize + (index < remainder ? 1 : 0)
    );
  }

  private async localSplit(
    sourceImage: string,
    rows: number,
    cols: number,
    lineThickness: number
  ): Promise<string[]> {
    const image = await loadImageElement(sourceImage);

    const maxLineByWidth =
      cols > 1 ? Math.floor((image.naturalWidth - cols) / (cols - 1)) : lineThickness;
    const maxLineByHeight =
      rows > 1 ? Math.floor((image.naturalHeight - rows) / (rows - 1)) : lineThickness;
    const maxAllowedLine = Math.max(0, Math.min(maxLineByWidth, maxLineByHeight));
    const resolvedLineThickness = Math.min(Math.max(0, lineThickness), maxAllowedLine);

    const usableWidth = image.naturalWidth - (cols - 1) * resolvedLineThickness;
    const usableHeight = image.naturalHeight - (rows - 1) * resolvedLineThickness;

    if (usableWidth < cols || usableHeight < rows) {
      throw new Error('分割线过粗，无法完成切割');
    }

    const columnWidths = this.splitIntoSegments(usableWidth, cols);
    const rowHeights = this.splitIntoSegments(usableHeight, rows);

    const results: string[] = [];

    const yOffsets: number[] = [];
    let yCursor = 0;
    for (let row = 0; row < rows; row += 1) {
      yOffsets.push(yCursor);
      yCursor += rowHeights[row];
      if (row < rows - 1) {
        yCursor += resolvedLineThickness;
      }
    }

    const xOffsets: number[] = [];
    let xCursor = 0;
    for (let col = 0; col < cols; col += 1) {
      xOffsets.push(xCursor);
      xCursor += columnWidths[col];
      if (col < cols - 1) {
        xCursor += resolvedLineThickness;
      }
    }

    for (let row = 0; row < rows; row += 1) {
      for (let col = 0; col < cols; col += 1) {
        const targetWidth = columnWidths[col];
        const targetHeight = rowHeights[row];

        const canvas = document.createElement('canvas');
        canvas.width = targetWidth;
        canvas.height = targetHeight;

        const context = canvas.getContext('2d');
        if (!context) {
          throw new Error('无法初始化画布');
        }

        context.drawImage(
          image,
          xOffsets[col],
          yOffsets[row],
          targetWidth,
          targetHeight,
          0,
          0,
          targetWidth,
          targetHeight
        );
        results.push(canvasToDataUrl(canvas));
      }
    }

    return results;
  }
}
