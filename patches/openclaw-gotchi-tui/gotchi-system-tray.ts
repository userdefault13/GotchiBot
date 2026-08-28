// Collapsible system-notice tray — OpenCode-style minimal chat when collapsed.
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import { tuiTheme as theme } from "../theme/theme.js";
import { sanitizeRenderableText } from "../tui-formatters.js";

type TrayEntry = {
  baseText: string;
  count: number;
  node: Text;
};

function formatEntryText(text: string, count: number): string {
  const sanitized = sanitizeRenderableText(text);
  const visible = sanitized.trim() || (text ? "(no output)" : "");
  const body = count > 1 ? `${visible} x${count}` : visible;
  return theme.system(body);
}

function truncateSummary(text: string, max = 48): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length <= max) {
    return oneLine;
  }
  return `${oneLine.slice(0, max - 1)}…`;
}

/** Groups system notices into one collapsible row (▸/▾) like OpenCode /details off. */
export class GotchiSystemTray extends Container {
  private expanded = false;
  private entries: TrayEntry[] = [];
  private header = new Text("", 1, 0);
  private body = new Container();

  constructor() {
    super();
    this.addChild(new Spacer(1));
    this.addChild(this.header);
    this.refreshHeader();
  }

  get entryCount(): number {
    return this.entries.reduce((sum, entry) => sum + entry.count, 0);
  }

  push(text: string, opts?: { coalesceConsecutive?: boolean }) {
    const last = this.entries[this.entries.length - 1];
    if (opts?.coalesceConsecutive && last?.baseText === text) {
      last.count += 1;
      last.node.setText(formatEntryText(text, last.count));
      this.refreshHeader();
      return;
    }
    const node = new Text(formatEntryText(text), 1, 0);
    this.entries.push({ baseText: text, count: 1, node });
    if (this.expanded) {
      this.body.addChild(node);
    }
    this.refreshHeader();
  }

  setExpanded(expanded: boolean) {
    if (this.expanded === expanded) {
      return;
    }
    this.expanded = expanded;
    this.body.clear();
    this.removeChild(this.body);
    if (expanded) {
      for (const entry of this.entries) {
        this.body.addChild(entry.node);
      }
      this.addChild(this.body);
    }
    this.refreshHeader();
  }

  toggleExpanded() {
    this.setExpanded(!this.expanded);
  }

  isExpanded(): boolean {
    return this.expanded;
  }

  clearAll() {
    this.entries = [];
    this.body.clear();
    this.removeChild(this.body);
    this.expanded = false;
    this.refreshHeader();
  }

  private refreshHeader() {
    const total = this.entryCount;
    const latest = this.entries[this.entries.length - 1]?.baseText ?? "";
    const summary = latest ? truncateSummary(latest) : "";
    const prefix = this.expanded ? "▾" : "▸";
    const label =
      total === 0
        ? `${prefix} system`
        : summary
          ? `${prefix} system · ${total} · ${summary}`
          : `${prefix} system · ${total}`;
    this.header.setText(theme.dim(label));
  }
}
