import type { NodeTypes } from '@xyflow/react';

import { ImageNode } from './ImageNode';
import { StoryboardGenNode } from './StoryboardGenNode';
import { StoryboardNode } from './StoryboardNode';
import { UploadNode } from './UploadNode';

export const nodeTypes: NodeTypes = {
  exportImageNode: ImageNode,
  imageNode: ImageNode,
  storyboardGenNode: StoryboardGenNode,
  storyboardNode: StoryboardNode,
  uploadNode: UploadNode,
};

export { ImageNode, StoryboardGenNode, StoryboardNode, UploadNode };
