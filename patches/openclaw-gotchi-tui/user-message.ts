// User message component renders user-authored chat entries in the TUI log.
import { tuiTheme as theme } from "../theme/theme.js";
import { formatGotchiUserMessageText, isGotchiOpencodeChrome } from "../gotchi-tui-chrome.js";
import { MarkdownMessageComponent } from "./markdown-message.js";

/** Markdown chat-log row styled as user input. */
export class UserMessageComponent extends MarkdownMessageComponent {
  constructor(text: string) {
    const gotchi = isGotchiOpencodeChrome();
    const body = gotchi ? formatGotchiUserMessageText(text) : text;
    super(
      body,
      gotchi ? 2 : 1,
      {
        bgColor: (line) => theme.userBg(line),
        color: (line) => (gotchi ? theme.accentSoft(line) : theme.userText(line)),
      },
      {
        preserveOrderedListMarkers: true,
        preserveBackslashEscapes: true,
      },
    );
  }
}
