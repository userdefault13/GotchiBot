// Gotchi startup progress bar — shown while the TUI connects and loads history.
import type { Component } from "@earendil-works/pi-tui";
import { Container, Text } from "@earendil-works/pi-tui";
import { isGotchiLoadProgressEnabled } from "./gotchi-tui-chrome.js";
import { tuiTheme as theme } from "./theme/theme.js";

export class GotchiLoadProgressBar extends Container {
  private readonly label: Text;
  private readonly bar: Text;
  private visible = true;
  private percent = 0;
  private message = "Starting…";

  constructor() {
    super();
    this.label = new Text("", 1, 0);
    this.bar = new Text("", 1, 0);
    this.addChild(this.label);
    this.addChild(this.bar);
    this.syncText(0, this.message);
  }

  setProgress(percent: number, message: string): void {
    if (!this.visible) {
      this.visible = true;
    }
    this.syncText(percent, message);
  }

  complete(): void {
    this.syncText(100, "Ready");
    this.visible = false;
    this.label.setText("");
    this.bar.setText("");
  }

  isVisible(): boolean {
    return this.visible;
  }

  private syncText(percent: number, message: string): void {
    this.percent = Math.max(0, Math.min(100, Math.round(percent)));
    this.message = message;
    this.label.setText(theme.dim(` ${message}`));
    this.bar.setText("");
  }

  render(width: number): string[] {
    if (!this.visible) {
      return [];
    }
    const barWidth = Math.max(12, Math.min(width - 8, 48));
    const filled = Math.round((this.percent / 100) * barWidth);
    const empty = barWidth - filled;
    const bar =
      " " +
      theme.accent("█".repeat(filled)) +
      theme.dim("░".repeat(empty)) +
      theme.accentSoft(` ${this.percent}%`);
    this.bar.setText(bar);
    return [...this.label.render(width), ...this.bar.render(width)];
  }

  invalidate(): void {
    this.label.invalidate();
    this.bar.invalidate();
  }
}

export type GotchiLoadProgressController = {
  set: (percent: number, message: string) => void;
  complete: () => void;
  isActive: () => boolean;
  component: Component | null;
};

export function createGotchiLoadProgressController(
  requestRender: () => void,
): GotchiLoadProgressController {
  if (!isGotchiLoadProgressEnabled()) {
    return { set: () => {}, complete: () => {}, isActive: () => false, component: null };
  }
  const bar = new GotchiLoadProgressBar();
  return {
    component: bar,
    isActive: () => bar.isVisible(),
    set(percent, message) {
      bar.setProgress(percent, message);
      requestRender();
    },
    complete() {
      bar.complete();
      requestRender();
    },
  };
}
