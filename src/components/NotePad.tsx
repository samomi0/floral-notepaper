import { useCallback, useEffect, useRef, useState } from "react";
import type { MouseEvent } from "react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  createNote,
  deleteNote,
  getErrorMessage,
  getNote,
  listCategories,
  listNotes,
  listTags,
  moveNoteCategory,
  updateNote,
} from "../features/notes/api";
import { useImagePaste } from "../features/images/useImagePaste";
import { useImageBaseDir } from "../features/images/useImageBaseDir";
import { reportInstallPreparation } from "../features/update/api";
import type { UpdateInstallPrepareRequest } from "../features/update/types";
import { showToast } from "./Toast";
import type { Note, NoteMetadata, Tag } from "../features/notes/types";
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
import { shouldSaveBeforeSwitchingToTile } from "../features/windows/noteSurfaceSavePolicy";
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

function popupStyle(
  buttonRef: React.RefObject<HTMLButtonElement | null>,
  estimatedHeight: number,
  marginLeft: number,
): React.CSSProperties {
  const rect = buttonRef.current?.getBoundingClientRect();
  if (!rect) return { left: 0, top: 0 };
  const spaceBelow = window.innerHeight - rect.bottom;
  const left = Math.min(rect.left, window.innerWidth - marginLeft);
  if (spaceBelow >= estimatedHeight + 8) {
    return { left, top: rect.bottom + 4 };
  }
  return { left, bottom: window.innerHeight - rect.top + 4 };
}

export function NotePad({
  initialNoteId,
  initialSurfaceMode = "pad",
  initialAutoSave = true,
  initialTileColor = DEFAULT_TILE_COLOR,
}: NotePadProps) {
  const { t } = useTranslation();
  const todayStr = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const [surfaceMode, setSurfaceMode] = useState<NoteSurfaceMode>(initialSurfaceMode);
  const [mode, setMode] = useState<OpenMode>("new");
  const [notes, setNotes] = useState<NoteMetadata[]>([]);
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [title, setTitle] = useState(initialNoteId ? "" : todayStr);
  const [content, setContent] = useState("");
  const [status, setStatus] = useState<NotePadStatus>("empty");
  const [noteSurfaceAutoSave, setNoteSurfaceAutoSave] = useState(initialAutoSave);
  const [tileColorRaw, setTileColorRaw] = useState(normalizeTileColor(initialTileColor));
  const [tileColorMode, setTileColorMode] = useState<TileColorMode>("system");
  const [surfaceFontSize, setSurfaceFontSize] = useState(14);
  const [tileRenderMarkdown, setTileRenderMarkdown] = useState(false);
  const [tileColor, setTileColor] = useState(() =>
    resolveTileColor("system", normalizeTileColor(initialTileColor)),
  );
  const [isExiting, setIsExiting] = useState(false);
  const [currentNoteTags, setCurrentNoteTags] = useState<string[]>([]);
  const [availableCategories, setAvailableCategories] = useState<string[]>([]);
  const [availableTags, setAvailableTags] = useState<Tag[]>([]);
  const [categoryPickerOpen, setCategoryPickerOpen] = useState(false);
  const categoryPickerRef = useRef<HTMLButtonElement>(null);
  const [tagPickerOpen, setTagPickerOpen] = useState(false);
  const tagPickerRef = useRef<HTMLButtonElement>(null);
  const [deleteConfirming, setDeleteConfirming] = useState(false);
  const deleteConfirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentNoteTagsRef = useRef(currentNoteTags);
  currentNoteTagsRef.current = currentNoteTags;
  const titleRef = useRef<HTMLInputElement>(null);
  const contentRef = useRef<HTMLTextAreaElement>(null);
  const windowLabelRef = useRef("");
  const statusRef = useRef<NotePadStatus>("empty");
  const contentValueRef = useRef(content);
  contentValueRef.current = content;
  const titleValueRef = useRef(title);
  titleValueRef.current = title;
  const isStandby = useRef(
    typeof window !== "undefined" &&
      new URLSearchParams(window.location.search).get("standby") === "1",
  );
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
    const loadedNotes = await listNotes();
    setNotes(loadedNotes);
    return loadedNotes;
  }, []);

  const applyNote = useCallback((note: Note) => {
    setEditingNoteId(note.id);
    setTitle(note.title);
    setContent(note.content);
    setCurrentNoteTags(note.tags ?? []);
    setMode("new");
    setStatus("opened");
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function bootstrap() {
      try {
        const [loadedConfig, loadedCategories, loadedTags] = await Promise.all([
          getConfig(),
          listCategories(),
          listTags(),
          refreshNotes(),
        ]);
        if (!cancelled) {
          setNoteSurfaceAutoSave(loadedConfig.noteSurfaceAutoSave);
          setSurfaceFontSize(loadedConfig.surfaceFontSize ?? 14);
          setTileRenderMarkdown(loadedConfig.tileRenderMarkdown ?? false);
          setTileColorRaw(normalizeTileColor(loadedConfig.tileColor));
          setTileColorMode(loadedConfig.tileColorMode ?? "system");
          setTileColor(
            resolveTileColor(loadedConfig.tileColorMode ?? "system", loadedConfig.tileColor),
          );
          setAvailableCategories(loadedCategories);
          setAvailableTags(loadedTags);
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
      void refreshNotes().catch(() => undefined);
      void listCategories()
        .then(setAvailableCategories)
        .catch(() => undefined);
      void listTags()
        .then(setAvailableTags)
        .catch(() => undefined);
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [refreshNotes]);

  useEffect(() => {
    if (isStandby.current) return;
    let cancelled = false;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (!cancelled) {
          hasEnteredOnce.current = true;
          void showCurrentWindow()
            .then(() => contentRef.current?.focus())
            .catch(() => undefined);
        }
      });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    return () => {
      if (deleteConfirmTimerRef.current) {
        clearTimeout(deleteConfirmTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const unlisten = listen<{
      tileColor?: string;
      tileColorMode?: TileColorMode;
      surfaceFontSize?: number;
      tileRenderMarkdown?: boolean;
    }>("config-changed", (event) => {
      const mode = event.payload.tileColorMode ?? tileColorMode;
      const raw = event.payload.tileColor ?? tileColorRaw;
      setTileColorMode(mode);
      setTileColorRaw(normalizeTileColor(raw));
      setTileColor(resolveTileColor(mode, raw));
      if (event.payload.surfaceFontSize != null) setSurfaceFontSize(event.payload.surfaceFontSize);
      if (event.payload.tileRenderMarkdown != null)
        setTileRenderMarkdown(event.payload.tileRenderMarkdown);
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [tileColorMode, tileColorRaw]);

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
      hasEnteredOnce.current = true;
      setEditingNoteId(null);
      setTitle(todayStr);
      setContent("");
      setCurrentNoteTags([]);
      setCategoryPickerOpen(false);
      setTagPickerOpen(false);
      setDeleteConfirming(false);
      if (deleteConfirmTimerRef.current) {
        clearTimeout(deleteConfirmTimerRef.current);
        deleteConfirmTimerRef.current = null;
      }
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

  const saveNote = useCallback(async () => {
    const existingCategory = notes.find((n) => n.id === editingNoteId)?.category ?? "";
    const resolvedTitle = title || new Date().toISOString().slice(0, 10);
    const tagsSnapshot = currentNoteTagsRef.current;
    const request = {
      title: resolvedTitle,
      content,
      category: existingCategory,
      tags: tagsSnapshot,
    };
    const note = editingNoteId
      ? await updateNote(editingNoteId, request)
      : await createNote(request);

    setEditingNoteId(note.id);
    setNotes((current) => {
      const metadata = metadataFromNote(note);
      const exists = current.some((item) => item.id === note.id);
      const next = exists
        ? current.map((item) => (item.id === note.id ? metadata : item))
        : [metadata, ...current];
      return [...next].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    });
    const contentChanged = contentValueRef.current !== content || titleValueRef.current !== title;
    setStatus(contentChanged ? "dirty" : "saved");
    return note;
  }, [content, editingNoteId, title]);

  useEffect(() => {
    const unlisten = listen<UpdateInstallPrepareRequest>("update://prepare-install", (event) => {
      const respond = async () => {
        const windowLabel = windowLabelRef.current || "notepad";
        if (statusRef.current !== "dirty") {
          await reportInstallPreparation(event.payload.requestId, windowLabel, "ready");
          return;
        }

        try {
          await saveNote();
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
  }, [saveNote]);

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
        if (nextMode === "tile") {
          await setCurrentWindowAlwaysOnTop(true);
        }

        const currentBounds = await getCurrentWindowBounds();
        await animateCurrentWindowBounds(getSurfaceTargetBounds(nextMode, currentBounds));
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

  const handleSave = useCallback(async () => {
    try {
      await saveNote();
    } catch (error) {
      setStatus("saveFailed");
      showToast(getErrorMessage(error));
    }
  }, [saveNote]);

  const handleMoveCategory = useCallback(
    async (targetCategory: string) => {
      setCategoryPickerOpen(false);
      if (editingNoteId) {
        try {
          await moveNoteCategory(editingNoteId, targetCategory);
          void refreshNotes().catch(() => undefined);
        } catch (error) {
          showToast(getErrorMessage(error));
        }
      }
    },
    [editingNoteId, refreshNotes],
  );

  const handleToggleNoteTag = useCallback((tagId: string) => {
    setCurrentNoteTags((prev) => {
      if (prev.includes(tagId)) {
        return prev.filter((id) => id !== tagId);
      }
      return [...prev, tagId];
    });
    setStatus("dirty");
  }, []);

  const closePopups = useCallback(() => {
    setCategoryPickerOpen(false);
    setTagPickerOpen(false);
  }, []);

  useEffect(() => {
    function handleMouseDown() {
      closePopups();
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") closePopups();
    }
    document.addEventListener("mousedown", handleMouseDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [closePopups]);

  const handleDelete = useCallback(async () => {
    if (!editingNoteId) {
      resetDraft();
      return;
    }

    if (!deleteConfirming) {
      setDeleteConfirming(true);
      deleteConfirmTimerRef.current = setTimeout(() => {
        setDeleteConfirming(false);
      }, 3000);
      return;
    }

    if (deleteConfirmTimerRef.current) {
      clearTimeout(deleteConfirmTimerRef.current);
      deleteConfirmTimerRef.current = null;
    }

    try {
      await deleteNote(editingNoteId);
      void refreshNotes().catch(() => undefined);
      resetDraft();
    } catch (error) {
      setDeleteConfirming(false);
      showToast(getErrorMessage(error));
    }
  }, [deleteConfirming, editingNoteId, refreshNotes]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key === "s") {
        event.preventDefault();
        void handleSave();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [handleSave]);

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
      if (shouldSaveBeforeSwitchingToTile(noteSurfaceAutoSave)) {
        await saveNote();
      }
      await switchSurfaceMode("tile");
    } catch (error) {
      showToast(getErrorMessage(error));
    }
  };

  const handleClose = useCallback(() => {
    setIsExiting(true);
    if (deleteConfirmTimerRef.current) {
      clearTimeout(deleteConfirmTimerRef.current);
      deleteConfirmTimerRef.current = null;
    }
    const closeSurface = surfaceMode === "tile" ? closeCurrentWindow : recycleCurrentNotepad;
    void closeSurface().catch((error) => {
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

  useEffect(() => {
    function handleSurfaceActionRequest(event: Event) {
      const action = surfaceActionFromEvent(event);
      if (!action) return;

      if (action === "copy") {
        void copyTileContent();
        return;
      }

      if (action === "save") {
        void handleSave();
        return;
      }

      if (action === "close") {
        void handleClose();
        return;
      }

      void switchSurfaceMode("pad");
    }

    window.addEventListener(NOTE_SURFACE_ACTION_EVENT, handleSurfaceActionRequest);
    return () => {
      window.removeEventListener(NOTE_SURFACE_ACTION_EVENT, handleSurfaceActionRequest);
    };
  }, [copyTileContent, handleClose, handleSave, switchSurfaceMode]);

  useEffect(() => {
    if (!noteSurfaceAutoSave || mode !== "new" || status !== "dirty") {
      return undefined;
    }
    if (!hasDraftContent()) return undefined;

    const timer = window.setTimeout(() => {
      void handleSave();
    }, 900);

    return () => window.clearTimeout(timer);
  }, [handleSave, hasDraftContent, mode, noteSurfaceAutoSave, status]);

  const handleDrag = (event: MouseEvent<HTMLElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest("button,input,textarea")) return;
    void startCurrentWindowDrag().catch(() => undefined);
  };

  const resetDraft = () => {
    setEditingNoteId(null);
    setTitle(todayStr);
    setContent("");
    setCurrentNoteTags([]);
    setMode("new");
    setStatus("empty");
    setDeleteConfirming(false);
    setCategoryPickerOpen(false);
    setTagPickerOpen(false);
  };

  const isTile = surfaceMode === "tile";
  const tileTitle = title.trim();
  const enterClass = hasEnteredOnce.current ? "" : "animate-window-enter";
  const surfaceWrapperClassName = `w-full h-screen flex flex-col bg-transparent p-0 ${isExiting ? "animate-window-exit" : enterClass}`;
  const padSurfaceClassName =
    "app-surface-frame relative noise-bg w-full h-full min-h-0 bg-cloud overflow-hidden flex flex-col flex-1 border border-paper-deep/70 shadow-[0_1px_10px_rgba(26,26,24,0.06)] transition-all duration-200 ease-out";

  return (
    <div className={surfaceWrapperClassName}>
      {isTile ? (
        <Tile
          title={tileTitle || undefined}
          content={content}
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
              className="flex items-center justify-between px-4 pt-3 pb-0 cursor-default"
              onMouseDown={handleDrag}
            >
              <div className="flex items-center gap-0.5">
                <button
                  onClick={resetDraft}
                  className={`relative px-3.5 py-1.5 text-[13px] rounded-t-lg transition-all duration-200 cursor-pointer ${
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
                  className={`relative px-3.5 py-1.5 text-[13px] rounded-t-lg transition-all duration-200 cursor-pointer ${
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

              <div className="flex items-center gap-1.5">
                <button
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
                    setTitle(event.target.value);
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

                <textarea
                  ref={contentRef}
                  data-tab-indent="true"
                  value={content}
                  onChange={(event) => {
                    setContent(event.target.value);
                    setStatus("dirty");
                  }}
                  onPaste={imagePasteHandler}
                  onDrop={imageDropHandler}
                  onDragOver={imageDragOverHandler}
                  onKeyDown={(event) => {
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
                  style={{ fontSize: `${surfaceFontSize}px`, tabSize: `var(--tab-indent-size, 2)` }}
                />

                <div className="flex items-center justify-between mt-auto pt-2 border-t border-paper-deep/30 shrink-0">
                  <span className="text-[11px] text-ink-ghost font-mono tabular-nums truncate max-w-[170px]">
                    {`${countNoteChars(content)} ${t("common.wordCountUnit", { defaultValue: "字" })} · ${statusLabel[status]}`}
                  </span>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => void handleDelete()}
                      className={`px-4 py-1.5 text-[12px] rounded-lg transition-all duration-200 cursor-pointer ${
                        deleteConfirming && editingNoteId
                          ? "text-cloud bg-red-400 hover:bg-red-500"
                          : "text-ink-faint hover:text-red-400 hover:bg-danger-bg/60"
                      }`}
                    >
                      {deleteConfirming && editingNoteId
                        ? t("notepad.button.confirmDelete", { defaultValue: "确认删除？" })
                        : t("notepad.button.delete", { defaultValue: "删除" })}
                    </button>
                    <button
                      onClick={() => void handleSave()}
                      className="px-4 py-1.5 text-[12px] text-cloud bg-bamboo hover:bg-bamboo-light rounded-lg transition-all duration-200 font-medium cursor-pointer"
                    >
                      {t("common.save", { defaultValue: "保存" })}
                    </button>
                  </div>
                </div>

                {editingNoteId && (
                  <div className="flex items-center gap-2 pt-2 shrink-0">
                    <button
                      ref={categoryPickerRef}
                      onClick={(e) => {
                        e.stopPropagation();
                        setCategoryPickerOpen((prev) => !prev);
                        setTagPickerOpen(false);
                      }}
                      className="flex items-center gap-1 h-[22px] px-1.5 rounded-md border border-paper-deep/50 bg-paper-warm/60 hover:border-bamboo/40 hover:bg-bamboo-mist/30 transition-colors cursor-pointer shrink-0"
                      title={t("main.category.changeCategory", { defaultValue: "切换分类" })}
                    >
                      <svg
                        width="10"
                        height="10"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        className="text-ink-ghost shrink-0"
                      >
                        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                      </svg>
                      <span className="text-[10px] text-ink-ghost truncate max-w-[100px]">
                        {notes.find((n) => n.id === editingNoteId)?.category ||
                          t("main.category.uncategorized", { defaultValue: "未分类" })}
                      </span>
                      <svg
                        width="8"
                        height="8"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="3"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        className="text-ink-ghost/50 shrink-0"
                      >
                        <polyline points="6 9 12 15 18 9" />
                      </svg>
                    </button>
                    <button
                      ref={tagPickerRef}
                      onClick={(e) => {
                        e.stopPropagation();
                        setTagPickerOpen((prev) => !prev);
                        setCategoryPickerOpen(false);
                      }}
                      className="flex items-center gap-1 h-[22px] px-1.5 rounded-md border border-paper-deep/50 bg-paper-warm/60 hover:border-bamboo/40 hover:bg-bamboo-mist/30 transition-colors cursor-pointer shrink-0"
                      title={t("main.tag.changeTag", { defaultValue: "切换标签" })}
                    >
                      <svg
                        width="10"
                        height="10"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        className="text-ink-ghost shrink-0"
                      >
                        <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z" />
                        <line x1="7" y1="7" x2="7.01" y2="7" />
                      </svg>
                      <span className="text-[10px] text-ink-ghost truncate max-w-[80px]">
                        {currentNoteTags.length > 0
                          ? `${currentNoteTags.length} 个标签`
                          : t("main.tag.noTag", { defaultValue: "标签" })}
                      </span>
                      <svg
                        width="8"
                        height="8"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="3"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        className="text-ink-ghost/50 shrink-0"
                      >
                        <polyline points="6 9 12 15 18 9" />
                      </svg>
                    </button>
                  </div>
                )}
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

      {categoryPickerOpen && editingNoteId && (
        <div
          className="popup-menu fixed z-[9999] min-w-[90px] bg-cloud/95 backdrop-blur-sm border border-paper-deep/50 rounded-lg select-none animate-menu-enter"
          style={popupStyle(categoryPickerRef, 180, 98)}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <button
            onClick={() => void handleMoveCategory("")}
            className="w-full text-left px-3 py-1.5 text-[12px] font-body text-ink-soft hover:bg-bamboo-mist/60 hover:text-bamboo transition-colors cursor-pointer"
          >
            {t("main.category.uncategorized", { defaultValue: "未分类" })}
          </button>
          {availableCategories.length > 0 && (
            <div className="max-h-[140px] overflow-y-auto border-t border-paper-deep/30">
              {availableCategories.map((cat) => (
                <button
                  key={cat}
                  onClick={() => void handleMoveCategory(cat)}
                  className="w-full text-left px-3 py-1.5 text-[12px] font-body text-ink-soft hover:bg-bamboo-mist/60 hover:text-bamboo transition-colors cursor-pointer"
                >
                  {cat}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {tagPickerOpen && editingNoteId && (
        <div
          className="popup-menu fixed z-[9999] min-w-[140px] bg-cloud/95 backdrop-blur-sm border border-paper-deep/50 rounded-lg select-none animate-menu-enter"
          style={popupStyle(tagPickerRef, 200, 148)}
          onMouseDown={(event) => event.stopPropagation()}
        >
          {availableTags.length === 0 ? (
            <div className="px-3 py-2 text-[11px] text-ink-ghost/50 text-center">
              {t("main.tag.empty", { defaultValue: "暂无标签" })}
            </div>
          ) : (
            <div className="max-h-[160px] overflow-y-auto py-1.5">
              {availableTags.map((tag) => {
                const checked = currentNoteTags.includes(tag.id);
                return (
                  <button
                    key={tag.id}
                    onClick={() => handleToggleNoteTag(tag.id)}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] font-body hover:bg-bamboo-mist/60 transition-colors cursor-pointer"
                  >
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className={`shrink-0 ${checked ? "text-bamboo" : "text-ink-ghost/30"}`}
                    >
                      {checked ? (
                        <>
                          <rect x="3" y="3" width="18" height="18" rx="3" />
                          <polyline points="8 12 11 15 16 9" />
                        </>
                      ) : (
                        <rect x="3" y="3" width="18" height="18" rx="3" />
                      )}
                    </svg>
                    <span
                      className="w-2.5 h-2.5 rounded-full shrink-0"
                      style={{ backgroundColor: tag.color }}
                    />
                    <span className={`truncate ${checked ? "text-bamboo" : "text-ink-soft"}`}>
                      {tag.name}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
