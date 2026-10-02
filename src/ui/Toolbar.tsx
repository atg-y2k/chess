import type { ComponentChild } from 'preact';
import './Toolbar.css';

export interface ToolbarItem {
  id: string;
  label: string;
  /** Usually an icon from `./icons` (24px). */
  icon: ComponentChild;
  onClick: () => void;
  disabled?: boolean;
  /** Toggle state; when defined the button is exposed as a toggle (aria-pressed). */
  active?: boolean;
}

export interface ToolbarProps {
  items: ToolbarItem[];
  /** Accessible name of the bar (default "Game controls"). */
  label?: string;
}

/** Bottom bar of equal-width buttons (icon over a small label), at least 52px tall. */
export function Toolbar({ items, label = 'Game controls' }: ToolbarProps) {
  return (
    <nav class="toolbar" aria-label={label}>
      {items.map((it) => (
        <button
          key={it.id}
          type="button"
          class="toolbar-btn"
          data-id={it.id}
          data-active={it.active ? '' : undefined}
          aria-pressed={it.active === undefined ? undefined : it.active}
          disabled={it.disabled}
          onClick={it.onClick}
        >
          <span class="toolbar-icon" aria-hidden="true">
            {it.icon}
          </span>
          <span class="toolbar-label">{it.label}</span>
        </button>
      ))}
    </nav>
  );
}
