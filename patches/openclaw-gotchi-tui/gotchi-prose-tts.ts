// Gotchi TUI — hover + right-click TTS on speakable prose (not code blocks).
import type { Component, TUI } from "@earendil-works/pi-tui";
import { SelectList, type SelectItem, isViewportTUI } from "@earendil-works/pi-tui";
import { spawn } from "node:child_process";
import { join } from "node:path";
import type { ScrollView } from "@earendil-works/pi-tui";
import { selectListTheme, tuiTheme as theme } from "./theme/theme.js";
import { isGotchiProseTtsEnabled } from "./gotchi-tui-chrome.js";
import { extractSpeakableProse, hasSpeakableProse } from "./gotchi-prose-segments.js";
import type { ChatLog } from "./components/chat-log.js";
import { AssistantMessageComponent } from "./components/assistant-message.js";

type MouseEvent = {
  button: number;
  x: number;
  y: number;
  release: boolean;
};

const ALL_MOTION_MOUSE = "\x1b[?1003h\x1b[?1004h";
const MENU_ITEMS: SelectItem[] = [
  { value: "speak", label: "Play aloud (EN-AU)" },
  { value: "cancel", label: "Cancel" },
];

function parseSgrMouseEvent(data: string): MouseEvent | undefined {
  const match = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(data);
  if (!match) {
    return undefined;
  }
  return {
    button: Number.parseInt(match[1] ?? "0", 10),
    x: Number.parseInt(match[2] ?? "0", 10) - 1,
    y: Number.parseInt(match[3] ?? "0", 10) - 1,
    release: match[4] === "m",
  };
}

function isMotionEvent(event: MouseEvent): boolean {
  return (event.button & 32) !== 0 && (event.button & 3) === 3;
}

function isRightClickRelease(event: MouseEvent): boolean {
  return event.release && (event.button & 3) === 2;
}

export function enableGotchiProseHoverMouse(): void {
  try {
    process.stdout.write(ALL_MOTION_MOUSE);
  } catch {
    // best-effort
  }
}

function spawnProseTts(gotchiRoot: string, text: string): void {
  const phrase = text.slice(0, 4000);
  if (!phrase.trim()) {
    return;
  }
  const script = join(gotchiRoot, "scripts", "tts.mjs");
  spawn(process.execPath, [script, "speak", phrase, "--persona", "gotchi", "--force"], {
    detached: true,
    stdio: "ignore",
  }).unref();
}

export function createGotchiProseTtsController(params: {
  tui: TUI;
  chatLog: ChatLog;
  chatScroll: ScrollView;
  header: Component;
  gotchiRoot: string;
  openOverlay: (component: Component) => { close: () => void };
  flash: (message: string) => void;
}): { dispose: () => void } {
  if (!isGotchiProseTtsEnabled()) {
    return { dispose: () => {} };
  }

  enableGotchiProseHoverMouse();

  let hovered: AssistantMessageComponent | undefined;
  let pendingSpeak: AssistantMessageComponent | undefined;
  let overlayClose: (() => void) | undefined;

  const setHovered = (next: AssistantMessageComponent | undefined) => {
    if (hovered === next) {
      return;
    }
    hovered?.setProseHover(false);
    hovered = next;
    hovered?.setProseHover(true);
    params.tui.requestRender();
  };

  const resolveContentRow = (mouseY: number, width: number): number | undefined => {
    const headerLines = params.header.render(width).length;
    const chatTop = headerLines;
    if (mouseY < chatTop) {
      return undefined;
    }
    const localRow = mouseY - chatTop;
    if (localRow < 0) {
      return undefined;
    }
    return params.chatScroll.scrollTop + localRow;
  };

  const findAssistantAtContentRow = (
    contentRow: number,
    width: number,
  ): AssistantMessageComponent | undefined => {
    let row = 0;
    for (const child of params.chatLog.children) {
      const lines = child.render(width);
      const height = lines.length;
      if (child instanceof AssistantMessageComponent && contentRow >= row && contentRow < row + height) {
        const prose = child.getSpeakableProse();
        if (hasSpeakableProse(prose)) {
          return child;
        }
        return undefined;
      }
      row += height;
    }
    return undefined;
  };

  const openSpeakMenu = (component: AssistantMessageComponent) => {
    overlayClose?.();
    pendingSpeak = component;
    const selector = new SelectList(MENU_ITEMS, 10, selectListTheme);
    selector.onSelect = (item: SelectItem) => {
      overlayClose?.();
      overlayClose = undefined;
      if (item.value === "speak" && pendingSpeak) {
        const text = extractSpeakableProse(pendingSpeak.getSourceText());
        if (text) {
          spawnProseTts(params.gotchiRoot, text);
          params.flash("Speaking…");
        } else {
          params.flash("No speakable prose here.");
        }
      }
      pendingSpeak = undefined;
    };
    selector.onCancel = () => {
      overlayClose?.();
      overlayClose = undefined;
      pendingSpeak = undefined;
    };
    overlayClose = params.openOverlay(selector).close;
  };

  const listener = (data: string) => {
    if (!isViewportTUI(params.tui) || params.tui.hasOverlay()) {
      return undefined;
    }
    const event = parseSgrMouseEvent(data);
    if (!event) {
      return undefined;
    }
    const width = Math.max(1, process.stdout.columns || 80);

    if (isMotionEvent(event)) {
      const contentRow = resolveContentRow(event.y, width);
      if (contentRow === undefined) {
        setHovered(undefined);
        return { consume: true };
      }
      setHovered(findAssistantAtContentRow(contentRow, width));
      return { consume: true };
    }

    if (isRightClickRelease(event)) {
      const contentRow = resolveContentRow(event.y, width);
      if (contentRow === undefined) {
        return { consume: true };
      }
      const target = findAssistantAtContentRow(contentRow, width);
      if (target) {
        openSpeakMenu(target);
        return { consume: true };
      }
      params.flash("No speakable prose under cursor.");
      return { consume: true };
    }

    return undefined;
  };

  params.tui.addInputListener(listener);

  return {
    dispose: () => {
      params.tui.removeInputListener(listener);
      setHovered(undefined);
      overlayClose?.();
    },
  };
}
