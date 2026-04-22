import type { ImageModelDefinition } from '../../types';

export const GOOGLE_GEMINI_FLASH_MODEL_ID = 'google/gemini-2.0-flash';

export const imageModel: ImageModelDefinition = {
  id: GOOGLE_GEMINI_FLASH_MODEL_ID,
  mediaType: 'image',
  displayName: 'Gemini 2.0 Flash',
  providerId: 'google',
  description: '支持文生图与图像编辑的多模态模型',
  eta: '30s',
  expectedDurationMs: 30000,
  defaultAspectRatio: '1:1',
  defaultResolution: 'auto',
  aspectRatios: [
    { value: '1:1', label: '1:1' },
    { value: '9:16', label: '9:16' },
    { value: '16:9', label: '16:9' },
    { value: '3:4', label: '3:4' },
    { value: '4:3', label: '4:3' },
  ],
  resolutions: [{ value: 'auto', label: 'Auto' }],
  resolveRequest: ({ referenceImageCount }) => ({
    requestModel: GOOGLE_GEMINI_FLASH_MODEL_ID,
    modeLabel: referenceImageCount > 0 ? '编辑模式' : '生成模式',
  }),
};
