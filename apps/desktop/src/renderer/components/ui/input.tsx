import * as React from 'react';

import { cn } from '../../lib/utils';

const MASK_CHAR = '•';
const PEEK_DELAY = 600;

type InputVariant = 'default' | 'peek-password';

interface InputProps extends Omit<React.ComponentProps<'input'>, 'onChange'> {
  variant?: InputVariant;
  /** Real value for peek-password variant (controlled) */
  realValue?: string;
  onChange?: React.ChangeEventHandler<HTMLInputElement>;
  /** Simplified onChange for peek-password that passes the real value */
  onValueChange?: (value: string) => void;
}

const baseClasses =
  'bg-bg-input border-alto-300 shadow-field focus-visible:border-border-secondary-selected focus-visible:ring-ring/30 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive dark:aria-invalid:border-destructive/50 rounded-lg border px-3 py-1.5 text-sm leading-5 font-semibold transition-colors file:h-6 file:text-xs/relaxed file:font-medium focus-visible:ring-2 aria-invalid:ring-2 file:text-foreground placeholder:font-medium placeholder:text-content-quaternary text-content-primary w-full min-w-0 outline-none file:inline-flex file:border-0 file:bg-transparent hover:border-border-input-hover disabled:pointer-events-none disabled:cursor-not-allowed disabled:border-border-input-disabled disabled:placeholder:text-content-quaternary-disabled';

function Input({ className, type, variant = 'default', realValue, onChange, onValueChange, ...props }: InputProps) {
  if (variant === 'peek-password') {
    return (
      <PeekPasswordField
        className={className}
        realValue={realValue ?? ''}
        onValueChange={(val) => {
          onValueChange?.(val);
          // Also fire a synthetic onChange if provided
          onChange?.({ target: { value: val } } as React.ChangeEvent<HTMLInputElement>);
        }}
        {...props}
      />
    );
  }

  return <input type={type} data-slot="input" className={cn(baseClasses, className)} onChange={onChange} {...props} />;
}

/* ─── Peek-password internal component ─── */

interface PeekPasswordFieldProps extends Omit<React.ComponentProps<'input'>, 'type' | 'onChange' | 'value'> {
  realValue: string;
  onValueChange: (value: string) => void;
}

function PeekPasswordField({ realValue, onValueChange, className, ...props }: PeekPasswordFieldProps) {
  const [displayValue, setDisplayValue] = React.useState(() => MASK_CHAR.repeat(realValue.length));
  const inputRef = React.useRef<HTMLInputElement>(null);
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevLenRef = React.useRef(realValue.length);
  const isPasteRef = React.useRef(false);
  const cursorPosRef = React.useRef<number | null>(null);

  // Sync display when value resets externally
  React.useEffect(() => {
    if (realValue.length === 0) {
      setDisplayValue('');
      prevLenRef.current = 0;
    }
  }, [realValue]);

  // Restore cursor position after display value updates
  React.useEffect(() => {
    if (cursorPosRef.current !== null && inputRef.current && document.activeElement === inputRef.current) {
      const pos = cursorPosRef.current;
      inputRef.current.setSelectionRange(pos, pos);
      cursorPosRef.current = null;
    }
  }, [displayValue]);

  const handlePaste = () => {
    isPasteRef.current = true;
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value;
    const cursorPos = e.target.selectionStart ?? raw.length;
    const prevLen = prevLenRef.current;
    const wasPaste = isPasteRef.current;
    isPasteRef.current = false;

    let newReal: string;

    if (raw.length > prevLen) {
      const addedCount = raw.length - prevLen;
      const insertPos = cursorPos - addedCount;
      const addedChars = raw.slice(insertPos, cursorPos);
      newReal = realValue.slice(0, insertPos) + addedChars + realValue.slice(insertPos);
    } else if (raw.length < prevLen) {
      const removedCount = prevLen - raw.length;
      const deletePos = cursorPos;
      newReal = realValue.slice(0, deletePos) + realValue.slice(deletePos + removedCount);
    } else {
      newReal = realValue;
      for (let i = 0; i < raw.length; i++) {
        if (raw[i] !== MASK_CHAR) {
          newReal = realValue.slice(0, i) + raw[i] + realValue.slice(i + 1);
          break;
        }
      }
    }

    onValueChange(newReal);
    prevLenRef.current = newReal.length;
    cursorPosRef.current = cursorPos;

    if (timerRef.current) clearTimeout(timerRef.current);

    if (newReal.length >= realValue.length && newReal !== realValue) {
      if (wasPaste) {
        // Paste — reveal all pasted characters
        const addedCount = newReal.length - realValue.length;
        const insertPos = cursorPos - addedCount;
        const masked =
          MASK_CHAR.repeat(Math.max(0, insertPos)) +
          newReal.slice(insertPos, cursorPos) +
          MASK_CHAR.repeat(Math.max(0, newReal.length - cursorPos));
        setDisplayValue(masked);
      } else {
        // Single char — peek just that one
        const peekIndex = cursorPos - 1;
        const masked =
          MASK_CHAR.repeat(Math.max(0, peekIndex)) +
          (newReal[peekIndex] ?? '') +
          MASK_CHAR.repeat(Math.max(0, newReal.length - peekIndex - 1));
        setDisplayValue(masked);
      }

      timerRef.current = setTimeout(() => {
        setDisplayValue(MASK_CHAR.repeat(newReal.length));
      }, PEEK_DELAY);
    } else {
      setDisplayValue(MASK_CHAR.repeat(newReal.length));
    }
  };

  // On focus, place cursor at end
  const handleFocus = (e: React.FocusEvent<HTMLInputElement>) => {
    const len = displayValue.length;
    setTimeout(() => {
      e.target.setSelectionRange(len, len);
    }, 0);
    props.onFocus?.(e);
  };

  React.useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  return (
    <input
      ref={inputRef}
      type="text"
      autoComplete="off"
      autoCorrect="off"
      spellCheck={false}
      data-slot="input"
      className={cn(baseClasses, className)}
      value={displayValue}
      onChange={handleChange}
      onPaste={handlePaste}
      onFocus={handleFocus}
      {...props}
    />
  );
}

export { Input };
