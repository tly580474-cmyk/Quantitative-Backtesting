import { useEffect, useMemo, useState } from 'react';
import { Button, Popover } from 'antd';
import {
  AimOutlined,
  ArrowRightOutlined,
  BgColorsOutlined,
  BorderOutlined,
  CheckOutlined,
  ClearOutlined,
  DeleteOutlined,
  EditOutlined,
  LineOutlined,
  MinusOutlined,
  NodeIndexOutlined,
  RedoOutlined,
  UndoOutlined,
} from '@ant-design/icons';
import { useDrawingStore } from '@/stores/useDrawingStore';
import { DEFAULT_DRAWING_COLOR } from '@/stores/useDrawingStore';
import type { DrawingTool } from './types';
import './drawing.css';

export interface DrawingToolbarProps {
  contextKey?: string;
  disabled?: boolean;
  className?: string;
  onToolChange?: (tool: DrawingTool) => void;
}

const TOOL_OPTIONS: Array<{
  value: Exclude<DrawingTool, 'select'>;
  label: string;
  hint: string;
  shortcut: string;
  icon: React.ReactNode;
}> = [
  {
    value: 'horizontal',
    label: '水平线',
    hint: '点击价格位置放置水平线',
    shortcut: 'H',
    icon: <MinusOutlined />,
  },
  {
    value: 'infinite-line',
    label: '直线',
    hint: '点击起点和方向点，延伸整张图',
    shortcut: 'L',
    icon: <NodeIndexOutlined />,
  },
  {
    value: 'segment',
    label: '线段',
    hint: '点击起点和终点绘制线段',
    shortcut: 'S',
    icon: <LineOutlined />,
  },
  {
    value: 'freehand',
    label: '自由画线',
    hint: '按住并拖动指针，自由绘制路径',
    shortcut: 'F',
    icon: <EditOutlined />,
  },
  {
    value: 'rectangle',
    label: '矩形',
    hint: '点击对角线的两个角绘制矩形',
    shortcut: 'B',
    icon: <BorderOutlined />,
  },
];

const COLOR_OPTIONS = [
  { value: DEFAULT_DRAWING_COLOR, label: '蓝色' },
  { value: '#7C3AED', label: '紫色' },
  { value: '#DC2626', label: '红色' },
  { value: '#EA580C', label: '橙色' },
  { value: '#16A34A', label: '绿色' },
  { value: '#0891B2', label: '青色' },
  { value: '#0F172A', label: '深灰色' },
] as const;

function colorLabel(color: string): string {
  return COLOR_OPTIONS.find((option) => option.value === color)?.label ?? '自定义颜色';
}

function toolLabel(tool: DrawingTool): string {
  if (tool === 'select') return '浏览';
  return TOOL_OPTIONS.find((option) => option.value === tool)?.label ?? '画线';
}

function statusText(
  tool: DrawingTool,
  draft: ReturnType<typeof useDrawingStore.getState>['draft'],
  drawingCount: number,
): string {
  if (draft) {
    if (draft.type === 'freehand') {
      return '自由画线：拖动指针绘制，松开完成（Esc 取消）';
    }
    return draft.points.length > 0
      ? `${toolLabel(draft.type)}：已选择起点，请点击终点（Esc 取消）`
      : `${toolLabel(draft.type)}：请在图表中选择起点`;
  }
  if (tool === 'select') {
    return drawingCount > 0 ? `已绘制 ${drawingCount} 条线，点击对象可选中` : '浏览模式：可拖动、缩放图表';
  }
  const option = TOOL_OPTIONS.find((item) => item.value === tool);
  return option?.hint ?? '请选择图表位置';
}

export default function DrawingToolbar({
  contextKey,
  disabled = false,
  className,
  onToolChange,
}: DrawingToolbarProps) {
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [colorPopoverOpen, setColorPopoverOpen] = useState(false);
  const tool = useDrawingStore((state) => state.tool);
  const draft = useDrawingStore((state) => state.draft);
  const drawings = useDrawingStore((state) => state.drawings);
  const selectedId = useDrawingStore((state) => state.selectedId);
  const color = useDrawingStore((state) => state.color);
  const canUndo = useDrawingStore((state) => state.canUndo);
  const canRedo = useDrawingStore((state) => state.canRedo);
  const setContextKey = useDrawingStore((state) => state.setContextKey);
  const setTool = useDrawingStore((state) => state.setTool);
  const setColor = useDrawingStore((state) => state.setColor);
  const setDraft = useDrawingStore((state) => state.setDraft);
  const undo = useDrawingStore((state) => state.undo);
  const redo = useDrawingStore((state) => state.redo);
  const remove = useDrawingStore((state) => state.delete);
  const update = useDrawingStore((state) => state.update);
  const clear = useDrawingStore((state) => state.clear);

  useEffect(() => {
    if (contextKey !== undefined) setContextKey(contextKey);
  }, [contextKey, setContextKey]);

  const activeDrawingTool = tool !== 'select';
  const status = useMemo(() => statusText(tool, draft, drawings.length), [drawings.length, draft, tool]);

  const chooseTool = (nextTool: DrawingTool) => {
    setTool(nextTool);
    if (nextTool === 'select') setDraft(null);
    setPopoverOpen(false);
    onToolChange?.(nextTool);
  };

  const chooseColor = (nextColor: string) => {
    const normalized = nextColor.toUpperCase();
    setColor(normalized);
    if (tool === 'select' && selectedId) {
      const selected = drawings.find((drawing) => drawing.id === selectedId);
      if (selected) update(selectedId, { style: { ...selected.style, color: normalized } });
    }
    setColorPopoverOpen(false);
  };

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && typeof target.matches === 'function'
        && target.matches('input, textarea, select, [contenteditable="true"]')) return;
      if (disabled) return;

      if (event.key === 'Escape') {
        event.preventDefault();
        if (draft) {
          setDraft(null);
          return;
        }
        if (tool !== 'select') chooseTool('select');
        return;
      }

      if ((event.key === 'Delete' || event.key === 'Backspace') && selectedId) {
        event.preventDefault();
        remove(selectedId);
        return;
      }

      if (event.ctrlKey || event.metaKey) {
        if (event.key.toLowerCase() === 'z') {
          event.preventDefault();
          if (event.shiftKey) redo();
          else undo();
        } else if (event.key.toLowerCase() === 'y') {
          event.preventDefault();
          redo();
        }
        return;
      }

      if (event.altKey || event.shiftKey) return;
      const shortcut = event.key.toLowerCase();
      if (shortcut === 'v') chooseTool('select');
      else if (shortcut === 'h') chooseTool('horizontal');
      else if (shortcut === 'l') chooseTool('infinite-line');
      else if (shortcut === 's') chooseTool('segment');
      else if (shortcut === 'f') chooseTool('freehand');
      else if (shortcut === 'b') chooseTool('rectangle');
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  });

  const menu = (
    <div className="drawing-toolbar__menu" role="menu" aria-label="画线工具选项">
      {TOOL_OPTIONS.map((option) => (
        <Button
          key={option.value}
          type={tool === option.value ? 'primary' : 'default'}
          role="menuitemradio"
          aria-checked={tool === option.value}
          aria-label={`${option.label}（快捷键 ${option.shortcut}）`}
          title={`${option.hint} · ${option.shortcut}`}
          icon={option.icon}
          disabled={disabled}
          onClick={() => chooseTool(option.value)}
        >
          <span>{option.label}</span>
          <kbd>{option.shortcut}</kbd>
        </Button>
      ))}
    </div>
  );

  const colorMenu = (
    <div className="drawing-toolbar__color-menu" role="menu" aria-label="画线颜色选项">
      <div className="drawing-toolbar__color-grid">
        {COLOR_OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            role="menuitemradio"
            aria-checked={color === option.value}
            aria-label={option.label}
            title={option.label}
            className="drawing-toolbar__color-option"
            onClick={() => chooseColor(option.value)}
          >
            <span className="drawing-toolbar__swatch" style={{ backgroundColor: option.value }} />
            <span>{option.label}</span>
            {color === option.value && <CheckOutlined aria-hidden="true" />}
          </button>
        ))}
      </div>
      <label className="drawing-toolbar__custom-color">
        <span><BgColorsOutlined /> 自定义颜色</span>
        <input
          type="color"
          aria-label="选择自定义画线颜色"
          value={color}
          disabled={disabled}
          onChange={(event) => chooseColor(event.target.value)}
        />
      </label>
    </div>
  );

  const toolbarClassName = ['drawing-toolbar', className].filter(Boolean).join(' ');
  return (
    <div className={toolbarClassName} role="toolbar" aria-label="画线工具栏">
      <Button
        className="drawing-toolbar__browse"
        type={tool === 'select' ? 'primary' : 'default'}
        icon={<AimOutlined />}
        aria-label="浏览模式"
        aria-pressed={tool === 'select'}
        disabled={disabled}
        onClick={() => chooseTool('select')}
      >
        浏览
      </Button>
      <Popover
        open={popoverOpen}
        onOpenChange={setPopoverOpen}
        trigger="click"
        placement="bottomLeft"
        title="画线工具"
        content={menu}
        overlayClassName="drawing-toolbar-popover"
      >
        <Button
          className="drawing-toolbar__trigger"
          type={activeDrawingTool ? 'primary' : 'default'}
          icon={<ArrowRightOutlined />}
          aria-label={`画线工具${activeDrawingTool ? `，当前为${toolLabel(tool)}` : ''}`}
          aria-haspopup="menu"
          aria-expanded={popoverOpen}
          disabled={disabled}
        >
          {activeDrawingTool ? toolLabel(tool) : '画线'}
        </Button>
      </Popover>
      <Popover
        open={colorPopoverOpen}
        onOpenChange={setColorPopoverOpen}
        trigger="click"
        placement="bottomLeft"
        title="画线颜色"
        content={colorMenu}
        overlayClassName="drawing-toolbar-popover"
      >
        <Button
          className="drawing-toolbar__color-trigger"
          aria-label={`画线颜色，当前为${colorLabel(color)}`}
          aria-haspopup="menu"
          aria-expanded={colorPopoverOpen}
          disabled={disabled}
          title={tool === 'select' && selectedId ? '选择颜色并应用到选中画线' : '选择新画线的颜色'}
          icon={<span className="drawing-toolbar__swatch" style={{ backgroundColor: color }} />}
        >
          颜色
        </Button>
      </Popover>
      <Button
        icon={<UndoOutlined />}
        aria-label="撤销画线操作"
        title="撤销画线操作（Ctrl/Cmd+Z）"
        disabled={disabled || !canUndo}
        onClick={undo}
      />
      <Button
        icon={<RedoOutlined />}
        aria-label="重做画线操作"
        title="重做画线操作（Ctrl/Cmd+Shift+Z）"
        disabled={disabled || !canRedo}
        onClick={redo}
      />
      <Button
        icon={<DeleteOutlined />}
        aria-label="删除选中画线"
        title="删除选中画线（Delete）"
        disabled={disabled || !selectedId}
        onClick={() => remove()}
      />
      <Button
        icon={<ClearOutlined />}
        aria-label="清除全部画线（可撤销）"
        title="清除全部画线（可通过撤销恢复）"
        disabled={disabled || drawings.length === 0}
        onClick={clear}
      />
      <span className="drawing-toolbar__status" role="status" aria-live="polite">
        {status}
      </span>
      <span className="drawing-toolbar__count" aria-label={`已绘制 ${drawings.length} 条画线`}>
        {drawings.length} 条
      </span>
    </div>
  );
}
