/**
 * 工具栏图标集（二期样式对齐轮 2026-10-25）：内部字形整体切换为 lucide
 * （与 Figma 原型像素级同源，见 components/lucide-data.tsx）；导出名与
 * 消费面（EditorPage 等）保持不变，零接线改动。尺寸 17 = 原型 Tool icon。
 */
import type { ReactElement } from 'react';
import { Lucide } from '../components/lucide-data';

type IconProps = {
  className?: string;
};

const I = (name: string, className?: string): ReactElement => <Lucide name={name} size={17} className={className} />;

/** 返回工作台 */
export function BackIcon({ className }: IconProps) {
  return I('ArrowLeft', className);
}
export function UndoIcon({ className }: IconProps) {
  return I('Undo2', className);
}
export function RedoIcon({ className }: IconProps) {
  return I('Redo2', className);
}
export function StructureIcon({ className }: IconProps) {
  return I('Network', className);
}
export function ThemeIcon({ className }: IconProps) {
  return I('LayoutPanelTop', className);
}
export function ExportIcon({ className }: IconProps) {
  return I('Upload', className);
}
export function MembersIcon({ className }: IconProps) {
  return I('Users', className);
}
export function HistoryIcon({ className }: IconProps) {
  return I('History', className);
}
export function KeyboardIcon({ className }: IconProps) {
  return I('Keyboard', className);
}
export function SearchIcon({ className }: IconProps) {
  return I('Search', className);
}
export function FullscreenIcon({ className }: IconProps) {
  return I('Maximize2', className);
}
export function PainterIcon({ className }: IconProps) {
  return I('Paintbrush', className);
}
export function InsertIcon({ className }: IconProps) {
  return I('Plus', className);
}
export function TaskIcon({ className }: IconProps) {
  return I('SquareCheck', className);
}
export function ActivityIcon({ className }: IconProps) {
  return I('ListChecks', className);
}
