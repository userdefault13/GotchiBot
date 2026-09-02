---
name: browser-tool
description: >
  Scriptable browser tool for GotchiBot agents (OpenCode sub-agents + OpenClaw orchestrator).
  Provides goto, snapshot, click, fill, screenshot, extract, links/forms, close.
  Dry-run safety masks destructive patterns; never echoes credentials.
license: MIT
compatibility: opencode
metadata:
  audience: orchestrator
  workflow: browser-tool
---

# Browser Tool (browser-tool)

## Overview

Provides a **CLI wrapper around Playwright** for GotchiBot agents (OpenCode sub-agents and OpenClaw orchestrator).
All output is structured JSON on stdout; human-readable errors on stderr.

**Key safety features:**
- **Host allowlist** — navigation blocked unless host matches `config/browser.allowlist.json`
- **Dry-run / confirm gate** — destructive clicks (submit/checkout/place-order/purchase/buy) blocked unless `--confirm "<exact action phrase>"` is passed
- **Masking** — password/payment field values are masked in all output
- **No hardcoded credentials** — read from env vars only (orchestrator fetches via abracadabra)

## Subcommands

### `goto <url>`

Navigates to the given URL. Enforces the host allowlist from `config/browser.allowlist.json`.

**Output (JSON on stdout):**

```json
{"type":"goto","status":"ok","url":"<url>","title":"<page-title>"}
```

or on error:

```json
{"type":"goto","status":"error","message":"Host \"example.com\" not in allowlist. Add to config/browser.allowlist.json"}
```

### `snapshot`

Takes an accessibility-tree snapshot of the current page. Returns compact JSON + text summary for agent consumption.

**Output (JSON on stdout):**

```json
{"type":"snapshot","status":"ok","nodes":[{"role":"button","name":"Submit"},{"role":"link","name":"Home"}],"text":"Login • GotchiBot"}
```

or on error:

```json
{"type":"snapshot","status":"error","message":"No page loaded. Use goto first."}
```

### `click <ref|selector>`

Click an element identified by a **ref** (stable identifier) or a CSS **selector**.

**Dry-run safety:** If the element's `textContent` or `aria-label` matches any pattern in `destructivePatterns` (default: `submit`, `checkout`, `place-order`, `purchase`, `buy`), the click is **BLOCKED** unless `--confirm "<exact action phrase>"` is passed on the command line.

**Output (JSON on stdout):**

```json
{"type":"click","status":"ok","ref":"<ref>","element":"<described-element>"}
```

or on error/blocked:

```json
{"type":"click","status":"error","message":"Dry-run blocked: element matches 'checkout' pattern. Pass --confirm 'click checkout on safeway cart' to override."}
```

### `fill <ref|selector> <value>`

Fill an input element identified by ref or selector with the given value.

**Masking:** If the input's `type` is `password`, `email`, or the selector matches a field that looks like a card number / expiry / CVV, the **value is masked** (e.g., `****-****-****-1234`) in all output.

**Output (JSON on stdout):**

```json
{"type":"fill","status":"ok","ref":"<ref>","value":"<masked-value>"}
```

or on error:

```json
{"type":"fill","status":"error","message":"No such element: <ref|selector>"}
```

### `screenshot [path]`

Take a PNG screenshot. Default path is `sessions/<session-id>/screenshot.png` or `tmp/screenshot.png`.

**Output (JSON on stdout):**

```json
{"type":"screenshot","status":"ok","path":"<absolute-path>"}
```

or on error:

```json
{"type":"screenshot","status":"error","message":"<error>"}
```

### `extract <selector>`

Extract text or attributes as JSON for the given CSS selector.

**Output (JSON on stdout):**

```json
{"type":"extract","status":"ok","selector":"<selector>","data":{"text":"<element-text>","attributes":{"href":"<url>"}}}
```

or on error:

```json
{"type":"extract","status":"error","message":"<error>"}
```

### `links`

List all interactive links on the current page with **refs** (stable identifiers generated from text + position).

**Output (JSON on stdout):**

```json
{"type":"links","status":"ok","links":[{"ref":"link-1","text":"Home","url":"https://example.com/"}]}
```

or on error:

```json
{"type":"links","status":"error","message":"<error>"}
```

### `forms`

List all forms on the current page with refs and input types.

**Output (JSON on stdout):**

```json
{"type":"forms","status":"ok","forms":[{"ref":"form-1","inputs":[{"ref":"form-1-email","type":"email","label":"Email"}]},{"ref":"form-2","inputs":[{"ref":"form-2-cc","type":"password","label":"Card"}]},{"ref":"form-2","inputs":[{"ref":"form-2-cc-last","type":"text","label":"CVV"}]}]}
```

or on error:

```json
{"type":"forms","status":"error","message":"<error>"}
```

### `close`

Close the current browser session.

**Output (JSON on stdout):**

```json
{"type":"close","status":"ok"}
```

## Safety Model

### Host Allowlist

- Default allows: `localhost`, `127.0.0.1`, `.aarcadeghst.com`
- Navigation to any other host fails with a clear error explaining that Julius adds hosts by editing `config/browser.allowlist.json` manually
- The allowlist file is **documented** with examples (see `config/browser.allowlist.json`)

### Dry-run / Confirm Gate (critical)

- By default, **any click** targeting elements matching `destructivePatterns` is **BLOCKED**
- Patterns list lives in the allowlist config, editable by Julius
- To override: pass `--confirm "<exact action phrase>"` on the command line
- Example: `--confirm "click checkout on safeway cart"` allows the click

**Pattern list (in `config/browser.allowlist.json`):**

```json
"destructivePatterns": ["submit", "checkout", "place-order", "purchase", "buy"]
```

### Masking

- Field values that look like passwords, payment card numbers, expiry dates, CVVs are masked in all output
- Mask format: `****-****-****-1234` for card numbers, `****` for passwords, `**/**` for expiry
- Never echo raw credential values — read from env vars only (orchestrator fetches via abracadabra)

### Credentials

- **Never** hardcoded and **never** echoed — read from env vars only
- Orchestrator fetches via abracadabra (`abra run gotchibot -- ...`)
- The browser tool itself never requests or stores secrets

## Starter Bros Cart-Fill Example

This example demonstrates the tool's safety model in action: filling a cart on Starter Bros grocery site and **stopping before checkout**, waiting for human confirmation.

```bash
# 1. Navigate to the grocery store (add '.starterbros.com' to allowlist first)
gotchi browser-tool --session grocery goto 'https://www.starterbros.com/groceries'

# 2. Extract product list to find the item
gotchi browser-tool --session grocery extract '.product-name'

# 3. Click the add-to-cart button for item "Organic Avocados"
gotchi browser-tool --session grocery click '.add-to-cart:has-text("Organic Avocados")'

# 4. Verify cart count
gotchi browser-tool --session grocery extract '.cart-count'

# 5. At this point, the cart is filled. STOP before checkout.
#    The dry-run gate will block any click matching 'checkout'/'buy' patterns
#    unless --confirm is passed. This is intentional — Julius must confirm.

# 6. When ready to checkout (only after explicit human confirmation):
gotchi browser-tool --session grocery --confirm "confirm checkout on starterbros cart" click '#checkout'
```

**Safety note:** Steps 1–5 complete the cart-fill. Step 6 requires `--confirm` because the element matches the `checkout` destructive pattern. Without `--confirm`, the click is blocked with a clear error message.

## Invoke (wrapper)

```bash
# From the repo root, with a cAavegotchi cartridge and wallet connected:
./scripts/browser-tool.mjs goto "https://example.com" --session myprofile
./scripts/browser-tool.mjs snapshot --session myprofile
./scripts/browser-tool.mjs click ".submit-btn" --session myprofile --confirm "click submit on login form"
./scripts/browser-tool.mjs fill "#password" "s3cr3t" --session myprofile
./scripts/browser-tool.mjs screenshot --session myprofile
./scripts/browser-tool.mjs extract "h1" --session myprofile
./scripts/browser-tool.mjs links --session myprofile
./scripts/browser-tool.mjs forms --session myprofile
./scripts/browser-tool.mjs close --session myprofile
```

## Debug / Raw access

If you need to pass arbitrary Playwright commands, use the `--debug` flag to dump the underlying Playwright CDP events (logged to stderr only, never included in JSON output).

## Skill registration

This skill is registered in `skills/registry.json` (see below). The orchestrator will auto-load it when a sub-agent is spawned with browser-tool tasks.

## Registry entry

The browser-tool skill should be added to `skills/registry.json` following the same format as `cursor-cli`:

```json
"browser-tool": {
  "status": "approved",
  "type": "skill",
  "source": "gotchibot",
  "description": "Scriptable browser tool for GotchiBot agents with Playwright — goto, snapshot, click, fill, screenshot, extract, links, forms, close. Dry-run safety + host allowlist + masking.",
  "path": ".opencode/skills/browser-tool/SKILL.md",
  "script": "scripts/browser-tool.mjs",
  "addedAt": "<date>"
}
```