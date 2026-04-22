import type { ImageModelDefinition } from '../../types';

export const GOOGLE_IMAGEN3_MODEL_ID = 'google/imagen-3';

export const imageModel: ImageModelDefinition = {
  id: GOOGLE_IMAGEN3_MODEL_ID,
  mediaType: 'image',
  displayName: 'Imagen 3',
  providerId: 'google',
  description: 'Google 高质量文生图专用模型，支持多种比例',
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
  resolveRequest: () => ({
    requestModel: GOOGLE_IMAGEN3_MODEL_ID,
    modeLabel: '生成模式',
  }),
};
