/**
 * Reusable media tree. In `numbering` mode each video shows an order dropdown
 * (blank = skip); otherwise it just displays the structure (with any assigned
 * number as a badge).
 */
import { useState } from 'react'
import type { MediaItem } from '@shared/types'

interface Props {
  media: MediaItem[]
  numbering?: boolean
  videoCount?: number
  onSetOrder?: (item: MediaItem, order: number | null) => void
  onRemove?: (item: MediaItem) => void
}

export default function MediaTree({ media, numbering, videoCount = 0, onSetOrder, onRemove }: Props) {
  return (
    <div className="space-y-0.5">
      {media.map((item) => (
        <Node
          key={item.id}
          item={item}
          depth={0}
          numbering={numbering}
          videoCount={videoCount}
          onSetOrder={onSetOrder}
          onRemove={onRemove}
        />
      ))}
    </div>
  )
}

interface NodeProps extends Omit<Props, 'media'> {
  item: MediaItem
  depth: number
}

function Node({ item, depth, numbering, videoCount = 0, onSetOrder, onRemove }: NodeProps) {
  const [open, setOpen] = useState(true)
  const isFolder = item.kind === 'folder'
  const numbered = typeof item.order === 'number'

  return (
    <div>
      <div
        className="group flex items-center gap-2 rounded px-2 py-1 hover:bg-ink-800"
        style={{ paddingLeft: depth * 16 + 8 }}
      >
        {isFolder ? (
          <button className="w-4 text-ink-400 shrink-0" onClick={() => setOpen((v) => !v)} aria-label={open ? 'Collapse' : 'Expand'}>
            {open ? '▾' : '▸'}
          </button>
        ) : (
          <span className="w-4 shrink-0" />
        )}
        <span className="shrink-0">{isFolder ? '📁' : '🎬'}</span>
        <span className={`flex-1 truncate text-sm ${numbered ? 'text-signal' : 'text-ink-200'}`}>{item.name}</span>

        {!isFolder && numbering && (
          <select
            className="bg-ink-800 border border-ink-700 rounded text-xs px-1 py-1 text-ink-200 shrink-0"
            value={item.order ?? ''}
            onChange={(e) => onSetOrder?.(item, e.target.value === '' ? null : Number(e.target.value))}
            title="Order this clip is edited in (blank = skip this clip)"
          >
            <option value="">— skip</option>
            {Array.from({ length: Math.max(videoCount, 1) }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>
                #{n}
              </option>
            ))}
          </select>
        )}
        {!isFolder && !numbering && numbered && (
          <span className="text-[10px] text-signal shrink-0">#{item.order}</span>
        )}
        {onRemove && (
          <button
            className="text-[11px] text-ink-500 opacity-0 group-hover:opacity-100 hover:text-cut shrink-0"
            onClick={() => onRemove(item)}
            title="Remove from media pool (does not delete the file)"
          >
            ✕
          </button>
        )}
      </div>

      {isFolder && open && item.children && (
        <div>
          {item.children.map((child) => (
            <Node
              key={child.id}
              item={child}
              depth={depth + 1}
              numbering={numbering}
              videoCount={videoCount}
              onSetOrder={onSetOrder}
              onRemove={onRemove}
            />
          ))}
        </div>
      )}
    </div>
  )
}

/** Flatten the tree to just its videos (any depth). */
export function flattenVideos(media: MediaItem[]): MediaItem[] {
  const out: MediaItem[] = []
  const walk = (items: MediaItem[]) => {
    for (const it of items) {
      if (it.kind === 'video') out.push(it)
      if (it.children) walk(it.children)
    }
  }
  walk(media)
  return out
}
