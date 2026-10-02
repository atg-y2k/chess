import type { ComponentChild } from 'preact';
import { useId } from 'preact/hooks';
import './Toggle.css';

export interface ToggleProps {
  label: string;
  /** Secondary line under the label. */
  description?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  /** Optional leading icon (e.g. from ./icons), drawn white on a rounded coloured tile. */
  icon?: ComponentChild;
  /** Tile colour behind the icon (a CSS colour or var), default var(--surface-3). */
  iconColor?: string;
  /** Stable hook for tests / integration (`data-id` on the button). */
  id?: string;
}

/**
 * A full-width settings row that acts as an accessible switch (`<button role="switch">` with
 * `aria-checked`): optional icon tile, label + description, and an iOS-style track on the right.
 * Put several inside a `.sheet-group` for an inset grouped list with hairline separators.
 */
export function Toggle({ label, description, checked, onChange, disabled, icon, iconColor, id }: ToggleProps) {
  const uid = useId();
  return (
    <button
      type="button"
      role="switch"
      class="toggle"
      aria-checked={checked ? 'true' : 'false'}
      aria-labelledby={`${uid}-l`}
      aria-describedby={description ? `${uid}-d` : undefined}
      data-id={id}
      data-icon={icon ? '' : undefined}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      {icon && (
        <span class="toggle-icon" style={iconColor ? { background: iconColor } : undefined} aria-hidden="true">
          {icon}
        </span>
      )}
      <span class="toggle-text">
        <span id={`${uid}-l`} class="toggle-label">
          {label}
        </span>
        {description && (
          <span id={`${uid}-d`} class="toggle-desc">
            {description}
          </span>
        )}
      </span>
      <span class="toggle-track" aria-hidden="true">
        <span class="toggle-thumb" />
      </span>
    </button>
  );
}
