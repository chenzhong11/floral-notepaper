import { Menu } from "@tauri-apps/api/menu";
import { useTaskPreviewUndo } from "../features/markdown/useTaskPreviewUndo";
import { invoke } from "@tauri-apps/api/core";
import { MarkdownPreviewLazy as MarkdownPreview } from "../features/markdown/MarkdownPreviewLazy";
import { insertTask, continueTask } from "../features/markdown/taskEditing";
import { useCallback, useEffect, useRef, useState } from "react";
import type { MouseEvent } from "react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { createNote, getErrorMessage, getNote, listNotes, updateNote } from "../features/notes/api";
import { useImagePaste } from "../features/images/useImagePaste";
import { useImageBaseDir } from "../features/images/useImageBaseDir";
import { reportInstallPreparation } from "../features/update/api";
import type { UpdateInstallPrepareRequest } from "../features/update/types";
import { showToast } from "./Toast";
import type { Note, NoteMetadata } from "../features/notes/types";
import { countNoteChars, metadataFromNote } from "../features/notes/noteUtils";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  animateCurrentWindowBounds,
  closeCurrentWindow,
  getCurrentWindowBounds,
  recycleCurrentNotepad,
  setCurrentWindowAlwaysOnTop,
  showCurrentWindow,
  startCurrentWindowDrag,
  startCurrentWindowDragWithOffset,
  startCurrentWindowResize,
} from "../features/windows/controls";
import type { ResizeDirection } from "../features/windows/controls";
import { getConfig } from "../features/settings/api";
import {
  DEFAULT_TILE_COLOR,
  normalizeTileColor,
  resolveTileColor,
} from "../features/settings/tileColor";
import type { TileColorMode } from "../features/settings/types";
import {
  shouldEnterPadFromTileOnDoubleClick,
  shouldReturnToTileAfterManualSave,
  shouldSaveBeforeSwitchingToTile,
} from "../features/windows/noteSurfaceSavePolicy";
import {
  NOTE_SURFACE_ACTION_EVENT,
  surfaceActionFromEvent,
} from "../features/windows/surfaceActions";
import {
  NOTE_SURFACE_MODE_EVENT,
  getSurfaceTargetBounds,
  surfaceModeFromEvent,
} from "../features/windows/surfaceMode";
import type { NoteSurfaceMode } from "../features/windows/surfaceMode";
import {
  emitTileWindowUnpinned,
  tileSurfaceModeUnpinNoteId,
} from "../features/windows/tileWindowEvents";
import { NotepadOpenPanel } from "./NotepadOpenPanel";
import { Tile } from "./Tile";

type OpenMode = "new" | "open";
type NotePadStatus = "empty" | "opened" | "saved" | "dirty" | "saveFailed" | "copied";

interface NotePadProps {
  initialNoteId?: string;
  initialSurfaceMode?: NoteSurfaceMode;
  initialAutoSave?: boolean;
  initialTileColor?: string;
}

const surfaceResizeHandles: Array<{
  direction: ResizeDirection;
  className: string;
  size: string;
}> = [
  {
    direction: "NorthWest",
    size: "w-8 h-8",
    className: "top-0 left-0 cursor-nwse-resize",
  },
  {
    direction: "NorthEast",
    size: "w-5 h-5",
    className: "top-0 right-0 cursor-nesw-resize",
  },
  {
    direction: "SouthWest",
    size: "w-8 h-8",
    className: "bottom-0 left-0 cursor-nesw-resize",
  },
  {
    direction: "SouthEast",
    size: "w-5 h-5",
    className: "bottom-0 right-0 cursor-nwse-resize",
  },
];

function isTileControlDoubleClickTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    Boolean(target.closest('button,input,textarea,select,a,[data-surface-resize-handle="true"]'))
  );
}

const TILE_DRAG_START_THRESHOLD_PX = 5;

function SurfaceResizeHandles() {
  return (
    <>
      {surfaceResizeHandles.map((handle) => (
        <div
          key={handle.direction}
          aria-hidden="true"
          data-surface-resize-handle="true"
          data-resize-direction={handle.direction}
          onMouseDown={(event) => {
            event.stopPropagation();
            void startCurrentWindowResize(handle.direction).catch(() => undefined);
          }}
          className={`absolute ${handle.size} opacity-0 ${handle.className}`}
        />
      ))}
    </>
  );
}

export function NotePad({
  initialNoteId,
  initialSurfaceMode = "pad",
  initialAutoSave = true,
  initialTileColor = DEFAULT_TILE_COLOR,
}: NotePadProps) {
  const { t } = useTranslation();
  const [surfaceMode, setSurfaceMode] = useState<NoteSurfaceMode>(
    new URLSearchParams(window.location.search).has("edge") ? "edge" : initialSurfaceMode,
  );
  const [preview, setPreview] = useState(new URLSearchParams(window.location.search).has("edge"));
  const [edgeExpanded, setEdgeExpanded] = useState(false);
  const [conflict, setConflict] = useState(false);
  const edgeBusy = useRef(false);
  const edgeStateRef = useRef({ mode: surfaceMode, expanded: edgeExpanded });
  edgeStateRef.current = { mode: surfaceMode, expanded: edgeExpanded };
  const revisionRef = useRef<string | undefined>(undefined);
  const editingIdRef = useRef<string | null>(null);
  const savingRef = useRef(false);
  const saveQueueRef = useRef<Promise<unknown>>(Promise.resolve());
  const [mode, setMode] = useState<OpenMode>("new");
  const [notes, setNotes] = useState<NoteMetadata[]>([]);
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [status, setStatus] = useState<NotePadStatus>("empty");
  const [noteSurfaceAutoSave, setNoteSurfaceAutoSave] = useState(initialAutoSave);
  const [tileColorRaw, setTileColorRaw] = useState(normalizeTileColor(initialTileColor));
  const [tileColorMode, setTileColorMode] = useState<TileColorMode>("system");
  const [surfaceFontSize, setSurfaceFontSize] = useState(14);
  const [tileRenderMarkdown, setTileRenderMarkdown] = useState(false);
  const [tileDoubleClickToEdit, setTileDoubleClickToEdit] = useState(false);
  const [tileSaveReturnsToPin, setTileSaveReturnsToPin] = useState(false);
  const [tileColor, setTileColor] = useState(() =>
    resolveTileColor("system", normalizeTileColor(initialTileColor)),
  );
  const [isExiting, setIsExiting] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);
  const contentRef = useRef<HTMLTextAreaElement>(null);
  const tileDragIntentRef = useRef<{ x: number; y: number } | null>(null);
  const windowLabelRef = useRef("");
  const statusRef = useRef<NotePadStatus>("empty");
  const contentValueRef = useRef(content);
  contentValueRef.current = content;
  const titleValueRef = useRef(title);
  titleValueRef.current = title;
  const tileColorModeRef = useRef(tileColorMode);
  tileColorModeRef.current = tileColorMode;
  const tileColorRawRef = useRef(tileColorRaw);
  tileColorRawRef.current = tileColorRaw;
  const isStandby = useRef(
    typeof window !== "undefined" &&
      new URLSearchParams(window.location.search).get("standby") === "1",
  );
  // 窗口位于池中（standby 预热或已回收隐藏）时为 true：
  // 休眠期间跳过笔记列表拉取，激活时统一刷新
  const dormantRef = useRef(isStandby.current);
  const hasEnteredOnce = useRef(false);
  const statusLabel = useMemo<Record<NotePadStatus, string>>(
    () => ({
      empty: t("notepad.status.empty", { defaultValue: "空" }),
      opened: t("notepad.status.opened", { defaultValue: "已打开" }),
      saved: t("notepad.status.saved", { defaultValue: "已保存" }),
      dirty: t("notepad.status.unsaved", { defaultValue: "未保存" }),
      saveFailed: t("notepad.status.saveFailed", { defaultValue: "保存失败" }),
      copied: t("notepad.status.copied", { defaultValue: "已复制" }),
    }),
    [t],
  );
  const tabLabels = useMemo(
    () => ({
      new: t("notepad.tab.new", { defaultValue: "新建" }),
      edit: t("notepad.tab.edit", { defaultValue: "编辑" }),
      open: t("notepad.tab.open", { defaultValue: "打开" }),
    }),
    [t],
  );
  statusRef.current = status;

  const refreshNotes = useCallback(async () => {
    // 池中休眠的窗口不拉取笔记列表，激活时会统一刷新
    if (dormantRef.current) return [] as NoteMetadata[];
    const loadedNotes = await listNotes();
    setNotes(loadedNotes);
    return loadedNotes;
  }, []);

  const applyNote = useCallback((note: Note) => {
    editingIdRef.current = note.id;
    revisionRef.current = note.updatedAt;
    titleValueRef.current = note.title;
    contentValueRef.current = note.content;
    statusRef.current = "opened";
    setConflict(false);
    setEditingNoteId(note.id);
    setTitle(note.title);
    setContent(note.content);
    setMode("new");
    setStatus("opened");
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function bootstrap() {
      try {
        const [loadedConfig] = await Promise.all([getConfig(), refreshNotes()]);
        if (!cancelled) {
          setNoteSurfaceAutoSave(loadedConfig.noteSurfaceAutoSave);
          setSurfaceFontSize(loadedConfig.surfaceFontSize ?? 14);
          setTileRenderMarkdown(loadedConfig.tileRenderMarkdown ?? false);
          setTileDoubleClickToEdit(loadedConfig.tileDoubleClickToEdit ?? false);
          setTileSaveReturnsToPin(loadedConfig.tileSaveReturnsToPin ?? false);
          setTileColorRaw(normalizeTileColor(loadedConfig.tileColor));
          setTileColorMode(loadedConfig.tileColorMode ?? "system");
          setTileColor(
            resolveTileColor(loadedConfig.tileColorMode ?? "system", loadedConfig.tileColor),
          );
        }
        if (initialNoteId) {
          const note = await getNote(initialNoteId);
          if (!cancelled) applyNote(note);
        }
      } catch (error) {
        if (!cancelled) showToast(getErrorMessage(error));
      }
    }

    void bootstrap();
    return () => {
      cancelled = true;
    };
  }, [applyNote, initialNoteId, refreshNotes]);

  useEffect(() => {
    const unlisten = listen("notes-changed", () => {
      void refreshNotes()
        .then(async (loaded) => {
          const id = editingIdRef.current;
          if (!id || savingRef.current || ["dirty", "saveFailed"].includes(statusRef.current))
            return;
          if (!loaded.some((note) => note.id === id)) return;
          const note = await getNote(id);
          if (
            editingIdRef.current === id &&
            !savingRef.current &&
            !["dirty", "saveFailed"].includes(statusRef.current)
          )
            applyNote(note);
        })
        .catch(() => undefined);
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [refreshNotes, applyNote]);

  useEffect(() => {
    if (isStandby.current) return;
    let cancelled = false;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (!cancelled) {
          hasEnteredOnce.current = true;
          void (
            edgeStateRef.current.mode === "edge" ? getCurrentWindow().show() : showCurrentWindow()
          )
            .then(() => {
              if (edgeStateRef.current.mode !== "edge") contentRef.current?.focus();
            })
            .catch(() => undefined);
        }
      });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const unlisten = listen<{
      tileColor?: string;
      tileColorMode?: TileColorMode;
      surfaceFontSize?: number;
      tileRenderMarkdown?: boolean;
      tileDoubleClickToEdit?: boolean;
      tileSaveReturnsToPin?: boolean;
    }>("config-changed", (event) => {
      const mode = event.payload.tileColorMode ?? tileColorModeRef.current;
      const raw = event.payload.tileColor ?? tileColorRawRef.current;
      setTileColorMode(mode);
      setTileColorRaw(normalizeTileColor(raw));
      setTileColor(resolveTileColor(mode, raw));
      if (event.payload.surfaceFontSize != null) setSurfaceFontSize(event.payload.surfaceFontSize);
      if (event.payload.tileRenderMarkdown != null)
        setTileRenderMarkdown(event.payload.tileRenderMarkdown);
      if (event.payload.tileDoubleClickToEdit != null)
        setTileDoubleClickToEdit(event.payload.tileDoubleClickToEdit);
      if (event.payload.tileSaveReturnsToPin != null)
        setTileSaveReturnsToPin(event.payload.tileSaveReturnsToPin);
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    if (tileColorMode !== "system") return;
    const observer = new MutationObserver(() => {
      setTileColor(resolveTileColor("system", tileColorRaw));
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => observer.disconnect();
  }, [tileColorMode, tileColorRaw]);

  useEffect(() => {
    let myLabel = "";
    try {
      myLabel = getCurrentWindow().label;
      windowLabelRef.current = myLabel;
    } catch {
      // not in Tauri environment (tests)
    }

    const unlisten = listen<string>("notepad:activate", (event) => {
      if (event.payload !== myLabel) return;

      isStandby.current = false;
      dormantRef.current = false;
      hasEnteredOnce.current = true;
      setEditingNoteId(null);
      setTitle("");
      setContent("");
      setMode("new");
      setStatus("empty");
      setIsExiting(false);
      setSurfaceMode("pad");
      void refreshNotes().catch(() => undefined);
      void showCurrentWindow()
        .then(() => contentRef.current?.focus())
        .catch(() => undefined);
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [refreshNotes]);

  const saveNote = useCallback((): Promise<Note> => {
    const run = saveQueueRef.current.then(async () => {
      const id = editingIdRef.current;
      const titleSnapshot = titleValueRef.current;
      const contentSnapshot = contentValueRef.current;
      const request = {
        title: titleSnapshot,
        content: contentSnapshot,
        category: notes.find((n) => n.id === id)?.category ?? "",
      };
      savingRef.current = true;
      try {
        const note = id
          ? await updateNote(id, request, revisionRef.current)
          : await createNote(request);
        editingIdRef.current = note.id;
        revisionRef.current = note.updatedAt;
        setEditingNoteId(note.id);
        setNotes((current) => [metadataFromNote(note), ...current.filter((n) => n.id !== note.id)]);
        const nextStatus =
          contentValueRef.current !== contentSnapshot || titleValueRef.current !== titleSnapshot
            ? "dirty"
            : "saved";
        statusRef.current = nextStatus;
        setStatus(nextStatus);
        return note;
      } catch (error) {
        statusRef.current = "saveFailed";
        setStatus("saveFailed");
        if (
          typeof error === "object" &&
          error &&
          "code" in error &&
          error.code === "noteConflict"
        ) {
          localStorage.setItem(
            `floral-conflict-pad-${id}`,
            JSON.stringify({ ...request, expectedUpdatedAt: revisionRef.current }),
          );
          setConflict(true);
        }
        throw error;
      } finally {
        savingRef.current = false;
      }
    });
    saveQueueRef.current = run.catch(() => undefined);
    return run;
  }, [notes]);

  // 通过 ref 持有最新的 saveNote，让下方的 Tauri 监听只注册一次，
  // 避免每次输入（content 变化）都注销再重注册事件监听
  const saveNoteRef = useRef(saveNote);
  saveNoteRef.current = saveNote;

  useEffect(() => {
    const unlisten = listen<UpdateInstallPrepareRequest>("update://prepare-install", (event) => {
      const respond = async () => {
        const windowLabel = windowLabelRef.current || "notepad";
        if (statusRef.current !== "dirty") {
          await reportInstallPreparation(event.payload.requestId, windowLabel, "ready");
          return;
        }

        try {
          await saveNoteRef.current();
          await reportInstallPreparation(event.payload.requestId, windowLabel, "ready");
        } catch (error) {
          setStatus("saveFailed");
          showToast(getErrorMessage(error));
          await reportInstallPreparation(
            event.payload.requestId,
            windowLabel,
            "failed",
            getErrorMessage(error),
          );
        }
      };

      void respond().catch(async (error) => {
        await reportInstallPreparation(
          event.payload.requestId,
          windowLabelRef.current || "notepad",
          "failed",
          getErrorMessage(error),
        ).catch(() => undefined);
      });
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);

  const hasDraftContent = useCallback(
    () => Boolean(editingNoteId || title.trim() || content.trim()),
    [content, editingNoteId, title],
  );

  const imageBaseDir = useImageBaseDir();

  const ensureNoteSaved = useCallback(async (): Promise<string | null> => {
    if (editingNoteId) return editingNoteId;
    try {
      const note = await saveNote();
      return note.id;
    } catch {
      return null;
    }
  }, [editingNoteId, saveNote]);

  const {
    handlePaste: imagePasteHandler,
    handleDrop: imageDropHandler,
    handleDragOver: imageDragOverHandler,
  } = useImagePaste({
    noteId: editingNoteId,
    textareaRef: contentRef,
    setContent,
    markDirty: () => setStatus("dirty"),
    onEnsureNoteSaved: ensureNoteSaved,
    onError: showToast,
    t,
  });

  const tileNoteId = editingNoteId ?? initialNoteId ?? "";

  const switchSurfaceMode = useCallback(
    async (nextMode: NoteSurfaceMode) => {
      const unpinnedNoteId = tileSurfaceModeUnpinNoteId(surfaceMode, nextMode, tileNoteId);
      setSurfaceMode(nextMode);
      if (unpinnedNoteId) {
        void emitTileWindowUnpinned(unpinnedNoteId).catch(() => undefined);
      }

      try {
        const currentBounds = await getCurrentWindowBounds();
        const targetBounds = getSurfaceTargetBounds(nextMode, currentBounds);

        if (nextMode === "tile") {
          await setCurrentWindowAlwaysOnTop(true);
        }

        await animateCurrentWindowBounds(targetBounds);
      } catch (error) {
        showToast(getErrorMessage(error));
      }
    },
    [surfaceMode, tileNoteId],
  );

  useEffect(() => {
    function handleSurfaceModeRequest(event: Event) {
      const nextMode = surfaceModeFromEvent(event);
      if (!nextMode) return;
      void switchSurfaceMode(nextMode);
    }

    window.addEventListener(NOTE_SURFACE_MODE_EVENT, handleSurfaceModeRequest);
    return () => {
      window.removeEventListener(NOTE_SURFACE_MODE_EVENT, handleSurfaceModeRequest);
    };
  }, [switchSurfaceMode]);

  useEffect(() => {
    if (surfaceMode !== "tile") return;
    void setCurrentWindowAlwaysOnTop(true).catch(() => undefined);
  }, [surfaceMode]);

  const handleSave = useCallback(
    async ({ isAutoSave = false }: { isAutoSave?: boolean } = {}) => {
      try {
        const savedNote = await saveNote();
        if (
          shouldReturnToTileAfterManualSave({
            enabled: tileSaveReturnsToPin,
            noteId: savedNote.id,
            currentMode: surfaceMode,
            isAutoSave,
          })
        ) {
          await switchSurfaceMode("tile");
        }
      } catch (error) {
        setStatus("saveFailed");
        showToast(getErrorMessage(error));
      }
    },
    [saveNote, surfaceMode, switchSurfaceMode, tileSaveReturnsToPin],
  );

  // 全局监听（Ctrl+S、表面动作）只注册一次，通过 ref 取最新回调，
  // 避免回调依赖 content 导致每次输入都重绑监听
  const handleSaveRef = useRef(handleSave);
  handleSaveRef.current = handleSave;

  const clearPendingTileDrag = useCallback(() => {
    tileDragIntentRef.current = null;
  }, []);

  useEffect(() => clearPendingTileDrag, [clearPendingTileDrag]);

  useEffect(() => {
    if (surfaceMode !== "tile" || !tileDoubleClickToEdit) {
      clearPendingTileDrag();
      return undefined;
    }

    const handleMouseMove = (event: globalThis.MouseEvent) => {
      const intent = tileDragIntentRef.current;
      if (!intent) return;
      // Pointer left the window during a missed mouseup, etc. — drop the stale intent.
      if ((event.buttons & 1) === 0) {
        clearPendingTileDrag();
        return;
      }

      const distanceX = event.screenX - intent.x;
      const distanceY = event.screenY - intent.y;
      const distance = Math.hypot(distanceX, distanceY);
      if (distance < TILE_DRAG_START_THRESHOLD_PX) return;

      tileDragIntentRef.current = null;
      // Compensate for the deadzone drift before handing off to the OS drag.
      void startCurrentWindowDragWithOffset(distanceX, distanceY).catch(() => undefined);
    };

    const handleMouseUp = () => clearPendingTileDrag();

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [clearPendingTileDrag, surfaceMode, tileDoubleClickToEdit]);

  const handleTileDoubleClick = useCallback(
    (event: MouseEvent<HTMLElement>) => {
      if (
        !shouldEnterPadFromTileOnDoubleClick(
          tileDoubleClickToEdit,
          isTileControlDoubleClickTarget(event.target),
        )
      ) {
        return;
      }

      clearPendingTileDrag();
      event.preventDefault();
      event.stopPropagation();
      void switchSurfaceMode("pad");
    },
    [clearPendingTileDrag, switchSurfaceMode, tileDoubleClickToEdit],
  );

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key === "s") {
        event.preventDefault();
        void handleSaveRef.current();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  const handleOpenNote = async (noteId: string) => {
    try {
      const note = await getNote(noteId);
      applyNote(note);
      await switchSurfaceMode("pad");
    } catch (error) {
      showToast(getErrorMessage(error));
    }
  };

  const handlePin = async () => {
    try {
      if (shouldSaveBeforeSwitchingToTile(noteSurfaceAutoSave) || !editingNoteId) {
        await saveNote();
      }
      await switchSurfaceMode("tile");
    } catch (error) {
      showToast(getErrorMessage(error));
    }
  };

  const handleClose = useCallback(() => {
    if (edgeStateRef.current.mode === "edge") {
      void collapseEdgeRef.current();
      return;
    }
    setIsExiting(true);
    if (surfaceMode === "tile") {
      void closeCurrentWindow().catch((error) => {
        setIsExiting(false);
        showToast(getErrorMessage(error));
      });
      return;
    }

    // 回收进窗口池：窗口只是被隐藏，立刻清空编辑器状态并进入休眠，
    // 避免上一篇笔记全文和笔记列表驻留在隐藏窗口的内存里
    dormantRef.current = true;
    void recycleCurrentNotepad()
      .then(() => {
        setEditingNoteId(null);
        setTitle("");
        setContent("");
        setNotes([]);
        setMode("new");
        setStatus("empty");
        setIsExiting(false);
      })
      .catch((error) => {
        dormantRef.current = false;
        setIsExiting(false);
        showToast(getErrorMessage(error));
      });
  }, [surfaceMode]);

  const copyTileContent = useCallback(async () => {
    try {
      const clipboard = navigator.clipboard;
      if (!clipboard?.writeText) {
        throw new Error(t("notepad.error.copyUnsupported", { defaultValue: "当前环境不支持复制" }));
      }
      await clipboard.writeText(content);
      setStatus("copied");
    } catch (error) {
      showToast(getErrorMessage(error));
    }
  }, [content, t]);

  const handleCloseRef = useRef(handleClose);
  handleCloseRef.current = handleClose;
  const copyTileContentRef = useRef(copyTileContent);
  copyTileContentRef.current = copyTileContent;
  const switchSurfaceModeRef = useRef(switchSurfaceMode);
  switchSurfaceModeRef.current = switchSurfaceMode;

  useEffect(() => {
    function handleSurfaceActionRequest(event: Event) {
      const action = surfaceActionFromEvent(event);
      if (!action) return;

      if (action === "copy") {
        void copyTileContentRef.current();
        return;
      }

      if (action === "save") {
        void handleSaveRef.current();
        return;
      }

      if (action === "close") {
        void handleCloseRef.current();
        return;
      }

      void switchSurfaceModeRef.current("pad");
    }

    window.addEventListener(NOTE_SURFACE_ACTION_EVENT, handleSurfaceActionRequest);
    return () => {
      window.removeEventListener(NOTE_SURFACE_ACTION_EVENT, handleSurfaceActionRequest);
    };
  }, []);

  useEffect(() => {
    if (!noteSurfaceAutoSave || mode !== "new" || status !== "dirty") {
      return undefined;
    }
    if (!hasDraftContent()) return undefined;

    const timer = window.setTimeout(() => {
      void handleSave({ isAutoSave: true });
    }, 900);

    return () => window.clearTimeout(timer);
  }, [handleSave, hasDraftContent, mode, noteSurfaceAutoSave, status]);

  const handleDrag = (event: MouseEvent<HTMLElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest("button,input,textarea")) return;

    if (surfaceMode === "tile" && tileDoubleClickToEdit) {
      if (event.button !== 0 || event.detail > 1) return;
      clearPendingTileDrag();
      tileDragIntentRef.current = {
        x: event.screenX,
        y: event.screenY,
      };
      return;
    }

    void startCurrentWindowDrag().catch(() => undefined);
  };

  const resetDraft = () => {
    editingIdRef.current = null;
    revisionRef.current = undefined;
    setEditingNoteId(null);
    setTitle("");
    setContent("");
    setMode("new");
    setStatus("empty");
  };

  const changeContent = (value: string) => {
    contentValueRef.current = value;
    statusRef.current = "dirty";
    setContent(value);
    setStatus("dirty");
  };
  useEffect(() => {
    if (!editingNoteId) return;
    const raw = localStorage.getItem(`floral-conflict-pad-${editingNoteId}`);
    if (!raw) return;
    try {
      const draft = JSON.parse(raw);
      if (typeof draft.title !== "string" || typeof draft.content !== "string") return;
      titleValueRef.current = draft.title;
      contentValueRef.current = draft.content;
      revisionRef.current = draft.expectedUpdatedAt;
      setTitle(draft.title);
      setContent(draft.content);
      setConflict(true);
      statusRef.current = "saveFailed";
      setStatus("saveFailed");
    } catch {
      /* Keep the recovery record. */
    }
  }, [editingNoteId]);

  const changePreview = useTaskPreviewUndo(content, changeContent, editingNoteId);
  const contextMenuRef = useRef<Menu | null>(null);
  const collapseEdgeRef = useRef<(nextNoteId?: string) => Promise<void>>(async () => {});
  const collapseEdge = async (nextNoteId?: string) => {
    if (edgeBusy.current || !edgeStateRef.current.expanded) return;
    edgeBusy.current = true;
    try {
      if (["dirty", "saveFailed"].includes(statusRef.current)) await saveNoteRef.current();
      if (statusRef.current === "dirty") throw new Error("内容仍在变化，请稍后收起");
      await invoke("edge_collapse");
      if (nextNoteId) await invoke("edge_expand", { noteId: nextNoteId });
    } catch (error) {
      showToast(getErrorMessage(error));
    } finally {
      edgeBusy.current = false;
    }
  };
  collapseEdgeRef.current = collapseEdge;
  const attachEdge = async () => {
    try {
      const note = await saveNoteRef.current();
      await invoke("edge_attach", { noteId: note.id });
      setMode("new");
      setPreview(true);
      setEdgeExpanded(false);
      setSurfaceMode("edge");
    } catch (error) {
      showToast(getErrorMessage(error));
    }
  };
  const detachEdge = async () => {
    try {
      await invoke("edge_detach");
      setSurfaceMode("pad");
      setPreview(false);
    } catch (error) {
      showToast(getErrorMessage(error));
    }
  };
  useEffect(() => {
    let alive = true;
    let moveTimer: ReturnType<typeof setTimeout>;
    const unlisteners = [
      getCurrentWindow().listen<{ expanded: boolean }>("edge-state", (event) => {
        if (!alive) return;
        setSurfaceMode("edge");
        setEdgeExpanded(event.payload.expanded);
        if (event.payload.expanded) {
          setPreview(true);
          const id = editingIdRef.current;
          if (id && !["dirty", "saveFailed"].includes(statusRef.current)) {
            void getNote(id)
              .then((note) => {
                if (
                  alive &&
                  editingIdRef.current === id &&
                  !savingRef.current &&
                  !["dirty", "saveFailed"].includes(statusRef.current)
                )
                  applyNote(note);
              })
              .catch((error) => showToast(getErrorMessage(error)));
          }
        }
      }),
      getCurrentWindow().listen<string | null>("edge-collapse-request", (event) => {
        void collapseEdgeRef.current(event.payload ?? undefined);
      }),
      getCurrentWindow().onFocusChanged(({ payload }) => {
        if (!payload)
          setTimeout(() => {
            if (!document.hasFocus() && edgeStateRef.current.mode === "edge")
              void collapseEdgeRef.current();
          }, 180);
      }),
      getCurrentWindow().onMoved(() => {
        clearTimeout(moveTimer);
        if (edgeStateRef.current.mode === "edge" && !edgeStateRef.current.expanded)
          moveTimer = setTimeout(() => {
            void invoke("edge_reposition").catch(() => undefined);
          }, 300);
      }),
    ];
    return () => {
      alive = false;
      clearTimeout(moveTimer);
      for (const p of unlisteners) void p.then((fn) => fn());
    };
  }, [applyNote]);

  const isTile = surfaceMode === "tile";
  const tileTitle = title.trim();
  const enterClass = hasEnteredOnce.current ? "" : "animate-window-enter";
  const surfaceWrapperClassName = `w-full h-screen flex flex-col bg-transparent p-0 ${isExiting ? "animate-window-exit" : enterClass}`;
  const padSurfaceClassName =
    "app-surface-frame relative noise-bg w-full h-full min-h-0 bg-cloud overflow-hidden flex flex-col flex-1 border border-paper-deep/70 shadow-[0_1px_10px_rgba(26,26,24,0.06)] transition-all duration-200 ease-out";

  return (
    <div className={surfaceWrapperClassName}>
      {surfaceMode === "edge" && !edgeExpanded ? (
        <div
          className="edge-tab"
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
            void (async () => {
              await contextMenuRef.current?.close();
              const menu = await Menu.new({
                items: [
                  {
                    id: "edge-undock",
                    text: "解除吸附",
                    action: () => {
                      void detachEdge();
                    },
                  },
                ],
              });
              contextMenuRef.current = menu;
              await menu.popup();
            })().catch((error) => showToast(getErrorMessage(error)));
          }}
        >
          <div
            className="edge-tab-grip"
            title="上下拖动调整位置"
            onMouseDown={(event) => {
              event.preventDefault();
              void startCurrentWindowDrag();
            }}
          >
            ⠿
          </div>
          <button
            className="edge-tab-label"
            title={title || "无标题笔记"}
            onClick={() =>
              void invoke("edge_expand", { noteId: editingIdRef.current }).catch((error) =>
                showToast(getErrorMessage(error)),
              )
            }
          >
            {(title.trim() || "笔记").slice(0, 6)}
          </button>
        </div>
      ) : isTile ? (
        <Tile
          title={tileTitle || undefined}
          content={content}
          onContentChange={changePreview}
          color={tileColor}
          fontSize={surfaceFontSize}
          renderMarkdown={tileRenderMarkdown}
          imageBaseDir={imageBaseDir ?? undefined}
          width="100%"
          className="h-full cursor-default"
          data-surface-mode={surfaceMode}
          data-context-menu="tile"
          data-note-id={tileNoteId}
          onMouseDown={handleDrag}
          onDoubleClick={handleTileDoubleClick}
        >
          <button
            type="button"
            aria-label="取消钉屏"
            title="取消钉屏"
            onMouseDown={(event) => event.stopPropagation()}
            onClick={() => void handleClose()}
            className="absolute top-2 right-2 z-10 w-6 h-6 flex items-center justify-center rounded-full text-ink-ghost/70 hover:text-red-400 hover:bg-danger-bg/80 transition-colors cursor-pointer"
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
            >
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
          <SurfaceResizeHandles />
        </Tile>
      ) : (
        <div className={padSurfaceClassName} data-surface-mode={surfaceMode}>
          <>
            <div
              className="pad-header flex items-center justify-between px-3 pt-3 pb-0 cursor-default"
              onMouseDown={handleDrag}
            >
              {surfaceMode !== "edge" && (
                <div className="pad-header-tabs flex items-center gap-0.5">
                  <button
                    onClick={resetDraft}
                    className={`relative px-2 py-1.5 text-[13px] rounded-t-lg transition-all duration-200 cursor-pointer ${
                      mode === "new"
                        ? "text-bamboo font-medium"
                        : "text-ink-ghost hover:text-ink-faint"
                    }`}
                  >
                    {editingNoteId ? tabLabels.edit : tabLabels.new}
                    {mode === "new" && (
                      <div className="absolute bottom-0 left-3 right-3 h-[2px] bg-bamboo rounded-full" />
                    )}
                  </button>
                  <button
                    onClick={() => setMode("open")}
                    className={`relative px-2 py-1.5 text-[13px] rounded-t-lg transition-all duration-200 cursor-pointer ${
                      mode === "open"
                        ? "text-bamboo font-medium"
                        : "text-ink-ghost hover:text-ink-faint"
                    }`}
                  >
                    {tabLabels.open}
                    {mode === "open" && (
                      <div className="absolute bottom-0 left-3 right-3 h-[2px] bg-bamboo rounded-full" />
                    )}
                  </button>
                </div>
              )}

              <div className="pad-header-actions ml-auto flex items-center gap-1.5">
                <button
                  className="pad-tool shrink-0 whitespace-nowrap"
                  onClick={() => (surfaceMode === "edge" ? void detachEdge() : void attachEdge())}
                  title={surfaceMode === "edge" ? "解除吸附" : "吸附到右侧"}
                >
                  {surfaceMode === "edge" ? (
                    "解除吸附"
                  ) : (
                    <>
                      ⇥ <span className="dock-action-label">右侧吸附</span>
                    </>
                  )}
                </button>
                <button
                  hidden={surfaceMode === "edge"}
                  onClick={() => void handlePin()}
                  className="group w-7 h-7 flex items-center justify-center rounded-lg transition-all duration-200 cursor-pointer text-ink-ghost hover:text-ink-faint hover:bg-paper-warm"
                  title={t("notepad.tooltip.pinToTile", { defaultValue: "转为磁贴" })}
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M12 17v5" />
                    <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 1 1 0 0 0 1-1V4a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v1a1 1 0 0 0 1 1 1 1 0 0 1 1 1z" />
                  </svg>
                </button>

                <button
                  onClick={() => void handleClose()}
                  className="group w-7 h-7 flex items-center justify-center rounded-lg text-ink-ghost hover:bg-danger-bg hover:text-red-400 transition-all duration-200 cursor-pointer"
                  title={t("notepad.tooltip.close", { defaultValue: "关闭" })}
                >
                  <svg
                    width="13"
                    height="13"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                  >
                    <path d="M18 6L6 18M6 6l12 12" />
                  </svg>
                </button>
              </div>
            </div>

            <div className="mx-4 mt-1 h-px bg-paper-deep/50" />

            {mode === "new" ? (
              <div
                data-pad-editor-body="true"
                className="px-4 pt-3 pb-2 flex flex-col flex-1 min-h-0"
              >
                <input
                  ref={titleRef}
                  type="text"
                  value={title}
                  onChange={(event) => {
                    titleValueRef.current = event.target.value;
                    setTitle(event.target.value);
                    statusRef.current = "dirty";
                    setStatus("dirty");
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === "ArrowDown") {
                      event.preventDefault();
                      contentRef.current?.focus();
                    }
                  }}
                  placeholder={t("notepad.placeholder.title", { defaultValue: "标题（可选）" })}
                  className="w-full font-display font-medium text-ink placeholder:text-ink-ghost/60 mb-2 tracking-wide shrink-0"
                  style={{ fontSize: `${surfaceFontSize}px` }}
                />

                <div className="pad-tools">
                  <button className="pad-tool" onClick={() => setPreview((value) => !value)}>
                    {preview ? "编辑" : "预览"}
                  </button>
                  <button
                    className="pad-tool"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => {
                      setPreview(false);
                      requestAnimationFrame(() => {
                        if (contentRef.current) insertTask(contentRef.current, changeContent);
                      });
                    }}
                  >
                    ☑ 待办
                  </button>
                  {surfaceMode === "edge" && (
                    <button className="pad-tool" onClick={() => void collapseEdge()}>
                      收起 ›
                    </button>
                  )}
                </div>
                {conflict && (
                  <div className="draft-conflict" role="alert">
                    其他窗口已更新，草稿已保留。
                    <button
                      onClick={() => {
                        void createNote({
                          title: title + "（草稿副本）",
                          content,
                          category: notes.find((n) => n.id === editingNoteId)?.category ?? "",
                        })
                          .then(async () => {
                            localStorage.removeItem(`floral-conflict-pad-${editingNoteId}`);
                            if (editingNoteId) applyNote(await getNote(editingNoteId));
                          })
                          .catch((error) => showToast(getErrorMessage(error)));
                      }}
                    >
                      另存草稿
                    </button>
                    <button
                      onClick={() => {
                        if (editingNoteId)
                          void getNote(editingNoteId)
                            .then((note) => {
                              localStorage.removeItem(`floral-conflict-pad-${editingNoteId}`);
                              applyNote(note);
                            })
                            .catch((error) => showToast(getErrorMessage(error)));
                      }}
                    >
                      载入最新
                    </button>
                  </div>
                )}
                {preview ? (
                  <div className="flex-1 min-h-0 overflow-auto">
                    <MarkdownPreview
                      content={content}
                      onContentChange={changePreview}
                      fontSize={surfaceFontSize}
                      imageBaseDir={imageBaseDir ?? undefined}
                    />
                  </div>
                ) : (
                  <textarea
                    ref={contentRef}
                    data-tab-indent="true"
                    value={content}
                    onChange={(event) => {
                      contentValueRef.current = event.target.value;
                      setContent(event.target.value);
                      statusRef.current = "dirty";
                      setStatus("dirty");
                    }}
                    onPaste={imagePasteHandler}
                    onDrop={imageDropHandler}
                    onDragOver={imageDragOverHandler}
                    onKeyDown={(event) => {
                      if (continueTask(event, changeContent)) return;
                      if (event.key === "ArrowUp") {
                        const ta = contentRef.current;
                        if (ta && ta.selectionStart === ta.selectionEnd) {
                          const textBeforeCursor = content.slice(0, ta.selectionStart);
                          if (!textBeforeCursor.includes("\n")) {
                            event.preventDefault();
                            titleRef.current?.focus();
                          }
                        }
                      }
                    }}
                    placeholder={t("notepad.placeholder.content", { defaultValue: "写点什么……" })}
                    className="w-full flex-1 min-h-0 pb-2 leading-relaxed text-ink-soft font-body placeholder:text-ink-ghost/50"
                    style={{
                      fontSize: `${surfaceFontSize}px`,
                      tabSize: `var(--tab-indent-size, 2)`,
                    }}
                  />
                )}

                <div className="flex items-center justify-between mt-auto pt-2 border-t border-paper-deep/30 shrink-0">
                  <span className="text-[11px] text-ink-ghost font-mono tabular-nums truncate max-w-[170px]">
                    {`${countNoteChars(content)} ${t("common.wordCountUnit", { defaultValue: "字" })} · ${statusLabel[status]}`}
                  </span>
                  <div className="flex items-center gap-2">
                    <button
                      hidden={surfaceMode === "edge"}
                      onClick={resetDraft}
                      className="px-4 py-1.5 text-[12px] text-ink-faint hover:text-ink-soft rounded-lg hover:bg-paper-warm transition-all duration-200 cursor-pointer"
                    >
                      {t("notepad.button.clear", { defaultValue: "清空" })}
                    </button>
                    <button
                      onClick={() => void handleSave()}
                      className="px-4 py-1.5 text-[12px] text-cloud bg-bamboo hover:bg-bamboo-light rounded-lg transition-all duration-200 font-medium cursor-pointer"
                    >
                      {t("common.save", { defaultValue: "保存" })}
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              <NotepadOpenPanel
                notes={notes}
                onOpenNote={(noteId) => void handleOpenNote(noteId)}
              />
            )}
          </>
          <SurfaceResizeHandles />
        </div>
      )}
    </div>
  );
}
