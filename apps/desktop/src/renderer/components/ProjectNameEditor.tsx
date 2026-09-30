import { useState, useRef, useEffect, useCallback } from 'react';
import { Check } from 'lucide-react';
import { Pen } from '@solar-icons/react';

export interface ProjectNameEditorProps {
  initialName: string;
  onSave: (newName: string) => void;
}

export function ProjectNameEditor({ initialName, onSave }: ProjectNameEditorProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [name, setName] = useState(initialName);
  const inputRef = useRef<HTMLInputElement>(null);
  const measureRef = useRef<HTMLSpanElement>(null);
  const [inputWidth, setInputWidth] = useState(0);

  const measure = useCallback(() => {
    if (measureRef.current) {
      setInputWidth(measureRef.current.scrollWidth);
    }
  }, []);

  useEffect(() => {
    if (isEditing) {
      measure();
      inputRef.current?.focus();
      inputRef.current?.select();
    } else {
      setName(initialName);
    }
  }, [isEditing, initialName, measure]);

  useEffect(() => {
    measure();
  }, [name, measure]);

  const handleSave = () => {
    const trimmed = name.trim();
    if (trimmed && trimmed !== initialName) {
      onSave(trimmed);
    } else {
      setName(initialName);
    }
    setIsEditing(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleSave();
    } else if (e.key === 'Escape') {
      setName(initialName);
      setIsEditing(false);
    }
  };

  const editorWidth = Math.max(inputWidth + 56, 80);

  return (
    <div
      className="relative flex items-center h-8 mb-[1px] min-w-0 shrink transition-[width] duration-200 ease-out"
      style={{ width: isEditing ? editorWidth : undefined }}
    >
      {/* Hidden span to measure text width */}
      <span
        ref={measureRef}
        className="absolute invisible whitespace-pre text-sm font-medium font-sans leading-5 tracking-normal pointer-events-none h-0 overflow-hidden"
        aria-hidden="true"
      >
        {name || ' '}
      </span>

      {/* View mode button */}
      <button
        type="button"
        onClick={() => !isEditing && setIsEditing(true)}
        className={`group flex items-center gap-2 py-1.5 cursor-pointer rounded-lg min-w-0
          transition-all duration-200 ease-out
          ${isEditing ? 'opacity-0 scale-95 pointer-events-none' : 'opacity-100 scale-100'}`}
      >
        <h1
          className="text-base font-black font-sans leading-6 tracking-normal text-content-primary truncate flex-1 text-left"
          title={initialName}
        >
          {initialName}
        </h1>
        <div className="size-7 -my-1.5 rounded-full flex items-center justify-center transition-colors hover:bg-bg-primary-hover shrink-0">
          <Pen className="size-4 text-content-tertiary group-hover:text-content-primary transition-colors" />
        </div>
      </button>

      {/* Edit mode */}
      <div
        className={`absolute left-0 top-1/2 -translate-y-1/2 flex items-center pl-3 pr-1 py-[7px] rounded-lg bg-bg-primary border border-border-primary-hover shadow-field origin-left
          transition-all duration-200 ease-out
          ${isEditing ? 'opacity-100 scale-100 pointer-events-auto' : 'opacity-0 scale-95 pointer-events-none'}`}
        style={{
          width: editorWidth,
          maxWidth: '100%', // FIX 2: When the parent wrapper is forced to stop growing by the screen edge, this keeps the absolute container inside it.
        }}
      >
        <input
          ref={inputRef}
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={handleSave}
          // min-w-0 allows the input to scroll internally if the text is longer than the max available space
          className="flex-1 min-w-0 bg-transparent outline-none text-sm font-medium font-sans leading-5 tracking-normal text-content-primary"
        />
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={handleSave}
          className="size-7 -my-1.5 rounded-full flex items-center justify-center transition-colors hover:bg-bg-primary-hover shrink-0"
        >
          <Check className="size-4" />
        </button>
      </div>
    </div>
  );
}
