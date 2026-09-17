import { z } from 'zod';
import type { StructureType } from '../enums';

export const createFileSchema = z.object({
  title: z.string().min(1).max(255).default('未命名脑图'),
});

export interface FileListItem {
  id: string;
  title: string;
  structure: StructureType;
  nodeCount: number;
  lastOpenedAt: string | null;
  updatedAt: string;
}
