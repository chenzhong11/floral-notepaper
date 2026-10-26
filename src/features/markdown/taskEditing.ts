import type { KeyboardEvent } from "react";

export interface TextEdit {
  start: number;
  end: number;
  text: string;
  selectionStart: number;
  selectionEnd: number;
}

export function taskLines(value: string, start: number, end = start): TextEdit {
  const from = start === 0 ? 0 : value.lastIndexOf("\n", start - 1) + 1;
  const last = end > start && value[end - 1] === "\n" ? end - 1 : end;
  const next = value.indexOf("\n", last);
  const to = next < 0 ? value.length : next;
  const source = value.slice(from, to);
  const lines = source.split("\n");
  const changes: { at: number; delta: number }[] = [];
  let offset = from;
  const text = lines
    .map((line) => {
      const original = line;
      if (
        (line.trim() || lines.length === 1) &&
        !/^\s*(?:[-+*]|\d+[.)])\s+\[[ xX]\](?:\s|$)/.test(line)
      ) {
        line = line.replace(/^(\s*)(?:(?:[-+*]|\d+[.)])\s+)?/, "$1- [ ] ");
        changes.push({
          at: offset + original.length - original.trimStart().length,
          delta: line.length - original.length,
        });
      }
      offset += original.length + 1;
      return line;
    })
    .join("\n");
  const shift = (position: number) =>
    position + changes.filter((c) => c.at <= position).reduce((n, c) => n + c.delta, 0);
  return { start: from, end: to, text, selectionStart: shift(start), selectionEnd: shift(end) };
}

export function taskEnter(value: string, start: number, end = start): TextEdit | null {
  if (start !== end) return null;
  const from = start === 0 ? 0 : value.lastIndexOf("\n", start - 1) + 1;
  const to = value.indexOf("\n", start);
  const line = value.slice(from, to < 0 ? value.length : to);
  const match = /^(\s*)((?:[-+*]|\d+[.)])\s+)\[[ xX]\][ \t]*(.*)$/.exec(line);
  if (!match || start < from + match[0].length - match[3].length) return null;
  if (!match[3].trim())
    return {
      start: from,
      end: from + line.length,
      text: "",
      selectionStart: from,
      selectionEnd: from,
    };
  const text = "\n" + match[1] + "- [ ] ";
  return {
    start,
    end,
    text,
    selectionStart: start + text.length,
    selectionEnd: start + text.length,
  };
}

export function applyTextEdit(
  textarea: HTMLTextAreaElement,
  edit: TextEdit,
  change: (value: string) => void,
) {
  textarea.focus({ preventScroll: true });
  textarea.setSelectionRange(edit.start, edit.end);
  // WebView2's native edit command keeps Ctrl+Z/Ctrl+Y working for toolbar actions.
  if (!document.execCommand("insertText", false, edit.text))
    textarea.setRangeText(edit.text, edit.start, edit.end);
  change(textarea.value);
  textarea.setSelectionRange(edit.selectionStart, edit.selectionEnd);
}

export function insertTask(textarea: HTMLTextAreaElement, change: (value: string) => void) {
  applyTextEdit(
    textarea,
    taskLines(textarea.value, textarea.selectionStart, textarea.selectionEnd),
    change,
  );
}

export function continueTask(
  event: KeyboardEvent<HTMLTextAreaElement>,
  change: (value: string) => void,
) {
  if (
    event.key !== "Enter" ||
    event.shiftKey ||
    event.ctrlKey ||
    event.altKey ||
    event.metaKey ||
    event.nativeEvent.isComposing ||
    event.keyCode === 229
  )
    return false;
  const textarea = event.currentTarget;
  const edit = taskEnter(textarea.value, textarea.selectionStart, textarea.selectionEnd);
  if (!edit) return false;
  event.preventDefault();
  applyTextEdit(textarea, edit, change);
  return true;
}
