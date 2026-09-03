---
name: pymupdf
description: >-
  Read/render/search PDFs with PyMuPDF (fitz) via gotchibot pdf or MCP
  gotchibot-pdf (pdf_info, pdf_text, pdf_render, pdf_search). Load when Julius
  asks about a PDF, extract text, or rasterize a page.
license: MIT
compatibility: opencode
metadata:
  audience: orchestrator
  workflow: pdf
---

# PyMuPDF tool (pymupdf)

## Prerequisites

Project venv (not global pip):

```bash
python3 -m venv .venv-pdf
.venv-pdf/bin/pip install -r requirements/pymupdf.txt
./scripts/gotchibot pdf check
```

No autonomous installs elsewhere. If `pdf check` fails, ask Julius to run the setup above (or `GOTCHIBOT_PDF_PYTHON=/path/to/python`).

## Exact commands

```bash
./scripts/gotchibot pdf check
./scripts/gotchibot pdf info path/to/file.pdf
./scripts/gotchibot pdf text path/to/file.pdf [--pages 0,2-4] [--max-chars N]
./scripts/gotchibot pdf render path/to/file.pdf --out build/pdf/page0.png [--page 0] [--dpi 144]
./scripts/gotchibot pdf search path/to/file.pdf "query"
```

Or MCP server **gotchibot-pdf**: `pdf_check`, `pdf_info`, `pdf_text`, `pdf_render`, `pdf_search`.

All CLI/MCP JSON on stdout. Paths confined by [`config/pymupdf.json`](config/pymupdf.json).

## Decision table

| Need | Tool |
| --- | --- |
| Is pymupdf up? | `pdf check` / `pdf_check` |
| Page count / metadata | `pdf info` / `pdf_info` |
| Extract text | `pdf text` / `pdf_text` |
| Page → PNG | `pdf render` / `pdf_render` |
| Find string | `pdf search` / `pdf_search` |

## Forbidden

- `pip install` globally / outside `.venv-pdf` without Julius
- Reading PDFs outside allowReadRoots
- Inventing PDF contents without running the tool
