// Assistant message component renders assistant responses and spacing in the TUI log.
import { Container, Spacer } from "@earendil-works/pi-tui";
import { markdownTheme, tuiTheme as theme } from "../theme/theme.js";
import { extractSpeakableProse } from "../gotchi-prose-segments.js";
import { isGotchiOpencodeChrome } from "../gotchi-tui-chrome.js";
import { HyperlinkMarkdown } from "./hyperlink-markdown.js";

export class AssistantMessageComponent extends Container {
  private body: HyperlinkMarkdown;
  private sourceText: string;
  private proseHover = false;

  constructor(text: string) {
    super();
    this.sourceText = text;
    const gotchi = isGotchiOpencodeChrome();
    this.body = new HyperlinkMarkdown(
      text,
      0,
      gotchi ? 2 : 1,
      markdownTheme,
      gotchi
        ? {
            bgColor: (line) => this.resolveAssistantBg(line),
            color: (line) => theme.assistantMessageText(line),
          }
        : {
            color: (line) => theme.assistantText(line),
          },
    );
    this.addChild(new Spacer(gotchi ? 2 : 1));
    this.addChild(this.body);
    if (gotchi) {
      this.addChild(new Spacer(1));
    }
  }

  private resolveAssistantBg(line: string): string {
    if (this.proseHover && isGotchiOpencodeChrome()) {
      return theme.assistantBgHover(line);
    }
    return theme.assistantBg(line);
  }

  getSourceText(): string {
    return this.sourceText;
  }

  getSpeakableProse(): string {
    return extractSpeakableProse(this.sourceText);
  }

  setProseHover(active: boolean): void {
    if (this.proseHover === active) {
      return;
    }
    this.proseHover = active;
    this.body.invalidate();
  }

  setText(text: string) {
    this.sourceText = text;
    this.body.setText(text);
  }
}
