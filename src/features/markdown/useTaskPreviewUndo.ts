import { useCallback, useEffect, useRef } from "react";

/** Undo only checkbox edits whose source still matches; never undo over newer text. */
export function useTaskPreviewUndo(
  content: string,
  change: (value: string) => void,
  documentId: string | null,
) {
  const current = useRef({ content, change });
  current.current = { content, change };
  const undo = useRef<Array<{ before: string; after: string }>>([]);
  const redo = useRef<Array<{ before: string; after: string }>>([]);
  useEffect(() => {
    undo.current = [];
    redo.current = [];
  }, [documentId]);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "z" || event.isComposing)
        return;
      if (
        event.target instanceof HTMLElement &&
        event.target.closest("input,textarea,[contenteditable=true]")
      )
        return;
      const source = event.shiftKey ? redo.current : undo.current;
      const target = event.shiftKey ? undo.current : redo.current;
      const step = source[source.length - 1];
      if (!step) return;
      if (current.current.content !== (event.shiftKey ? step.before : step.after)) {
        undo.current = [];
        redo.current = [];
        return;
      }
      event.preventDefault();
      source.pop();
      target.push(step);
      current.current.change(event.shiftKey ? step.after : step.before);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);
  return useCallback((value: string) => {
    undo.current.push({ before: current.current.content, after: value });
    if (undo.current.length > 100) undo.current.shift();
    redo.current = [];
    current.current.change(value);
  }, []);
}
