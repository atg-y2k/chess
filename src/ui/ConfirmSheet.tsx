import { Sheet } from './Sheet';
import './ConfirmSheet.css';

export interface ConfirmSheetProps {
  open: boolean;
  /** Question in the header (also the dialog's name), e.g. "Use a hint?". */
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel?: string;
  onConfirm: () => void;
  /** Cancel, backdrop tap, swipe down or Escape. */
  onClose: () => void;
}

/** Help that makes a rated game unrated (hint, takeback, Retry). */
export type AssistPromptKind = 'hint' | 'undo' | 'retry';

const UNRATED = 'makes this game unrated: win or lose, your rating stays the same.';

/** Wording of the "this makes the game unrated" confirmation for each kind of help. */
export function assistPrompt(kind: AssistPromptKind): Pick<ConfirmSheetProps, 'title' | 'message' | 'confirmLabel'> {
  switch (kind) {
    case 'hint':
      return { title: 'Use a hint?', message: `Using a hint ${UNRATED}`, confirmLabel: 'Show hint' };
    case 'undo':
      return { title: 'Take back your move?', message: `Taking a move back ${UNRATED}`, confirmLabel: 'Take back' };
    case 'retry':
      return { title: 'Retry this move?', message: `Retry takes your move back, which ${UNRATED}`, confirmLabel: 'Retry' };
  }
}

/** A small bottom sheet that asks one yes / no question. */
export function ConfirmSheet({ open, title, message, confirmLabel, cancelLabel = 'Cancel', onConfirm, onClose }: ConfirmSheetProps) {
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={title}
      class="confirm"
      footer={
        <div class="confirm-btns">
          <button type="button" class="btn confirm-btn" data-id="confirm-cancel" onClick={onClose}>
            {cancelLabel}
          </button>
          <button type="button" class="btn btn-primary confirm-btn" data-id="confirm-ok" onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      }
    >
      <p class="confirm-text">{message}</p>
    </Sheet>
  );
}
