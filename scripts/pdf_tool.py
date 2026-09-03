#!/usr/bin/env python3
"""GotchiBot PyMuPDF CLI — JSON on stdout. Subcommands: check|info|text|render|search."""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path


def die(msg: str, code: int = 1) -> None:
    print(msg, file=sys.stderr)
    sys.exit(code)


def load_cfg(root: Path) -> dict:
    p = root / "config" / "pymupdf.json"
    if not p.is_file():
        return {
            "allowReadRoots": [".", "~/Downloads", "~/Dev"],
            "allowWriteRoots": [".", "build", "tmp", "var"],
            "defaultRenderDir": "build/pdf",
        }
    return json.loads(p.read_text())


def expand_root(s: str, repo: Path) -> Path:
    s = s.replace("~", str(Path.home()))
    p = Path(s)
    if not p.is_absolute():
        p = (repo / p).resolve()
    else:
        p = p.resolve()
    return p


def under_roots(path: Path, roots: list[str], repo: Path) -> bool:
    try:
        path = path.resolve()
    except OSError:
        return False
    for r in roots:
        base = expand_root(r, repo)
        try:
            path.relative_to(base)
            return True
        except ValueError:
            continue
    return False


def resolve_in(path_s: str, roots: list[str], repo: Path, *, must_exist: bool) -> Path:
    p = Path(path_s).expanduser()
    if not p.is_absolute():
        p = (Path.cwd() / p).resolve()
    else:
        p = p.resolve()
    if must_exist and not p.is_file():
        die(f"file not found: {p}")
    if not under_roots(p, roots, repo):
        die(f"path outside allowlist: {p}")
    return p


def cmd_check() -> None:
    try:
        import pymupdf as fitz  # type: ignore
    except ImportError:
        try:
            import fitz  # type: ignore
        except ImportError:
            print(
                json.dumps(
                    {
                        "ok": False,
                        "error": "pymupdf not installed",
                        "hint": "python3 -m venv .venv-pdf && .venv-pdf/bin/pip install -r requirements/pymupdf.txt",
                    }
                )
            )
            sys.exit(1)
    ver = getattr(fitz, "VersionBind", None) or getattr(fitz, "version", ("?",))[0]
    print(json.dumps({"ok": True, "pymupdf": str(ver), "python": sys.executable}))


def open_doc(path: Path):
    try:
        import pymupdf as fitz  # type: ignore
    except ImportError:
        import fitz  # type: ignore

    return fitz.open(path)


def cmd_info(path: Path) -> None:
    doc = open_doc(path)
    try:
        meta = doc.metadata or {}
        print(
            json.dumps(
                {
                    "ok": True,
                    "path": str(path),
                    "pages": doc.page_count,
                    "is_pdf": doc.is_pdf,
                    "needs_pass": doc.needs_pass,
                    "metadata": {k: v for k, v in meta.items() if v},
                }
            )
        )
    finally:
        doc.close()


def cmd_text(path: Path, pages: list[int] | None, max_chars: int) -> None:
    doc = open_doc(path)
    try:
        idxs = pages if pages is not None else list(range(doc.page_count))
        out = []
        total = 0
        for i in idxs:
            if i < 0 or i >= doc.page_count:
                die(f"page out of range: {i} (0..{doc.page_count - 1})")
            t = doc.load_page(i).get_text("text") or ""
            if max_chars > 0 and total + len(t) > max_chars:
                t = t[: max(0, max_chars - total)]
                out.append({"page": i, "text": t, "truncated": True})
                total = max_chars
                break
            out.append({"page": i, "text": t, "truncated": False})
            total += len(t)
        print(
            json.dumps(
                {
                    "ok": True,
                    "path": str(path),
                    "pages": len(out),
                    "chars": total,
                    "content": out,
                }
            )
        )
    finally:
        doc.close()


def cmd_render(
    path: Path,
    page: int,
    out: Path,
    dpi: float,
    repo: Path,
    write_roots: list[str],
) -> None:
    parent = out.parent.resolve()
    if not under_roots(parent, write_roots, repo):
        die(f"output outside allowlist: {out}")

    out.parent.mkdir(parents=True, exist_ok=True)
    doc = open_doc(path)
    try:
        if page < 0 or page >= doc.page_count:
            die(f"page out of range: {page} (0..{doc.page_count - 1})")
        pix = doc.load_page(page).get_pixmap(dpi=dpi)
        pix.save(str(out))
        print(
            json.dumps(
                {
                    "ok": True,
                    "path": str(path),
                    "page": page,
                    "out": str(out.resolve()),
                    "dpi": dpi,
                    "width": pix.width,
                    "height": pix.height,
                }
            )
        )
    finally:
        doc.close()


def cmd_search(path: Path, query: str, max_hits: int) -> None:
    doc = open_doc(path)
    try:
        hits = []
        for i in range(doc.page_count):
            page = doc.load_page(i)
            for r in page.search_for(query) or []:
                hits.append(
                    {
                        "page": i,
                        "x0": r.x0,
                        "y0": r.y0,
                        "x1": r.x1,
                        "y1": r.y1,
                    }
                )
                if len(hits) >= max_hits:
                    break
            if len(hits) >= max_hits:
                break
        print(
            json.dumps(
                {
                    "ok": True,
                    "path": str(path),
                    "query": query,
                    "hits": hits,
                    "count": len(hits),
                    "truncated": len(hits) >= max_hits,
                }
            )
        )
    finally:
        doc.close()


def parse_pages(s: str | None) -> list[int] | None:
    if not s:
        return None
    out: list[int] = []
    for part in s.split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            a, b = part.split("-", 1)
            lo, hi = int(a), int(b)
            out.extend(range(lo, hi + 1))
        else:
            out.append(int(part))
    return out


def main() -> None:
    repo = Path(__file__).resolve().parents[1]
    cfg = load_cfg(repo)
    read_roots = cfg.get("allowReadRoots") or ["."]
    write_roots = cfg.get("allowWriteRoots") or [".", "build"]

    ap = argparse.ArgumentParser(prog="pdf_tool.py")
    sub = ap.add_subparsers(dest="cmd", required=True)

    sub.add_parser("check")

    p_info = sub.add_parser("info")
    p_info.add_argument("pdf")

    p_text = sub.add_parser("text")
    p_text.add_argument("pdf")
    p_text.add_argument("--pages", help="0-based pages, e.g. 0,2-4")
    p_text.add_argument("--max-chars", type=int, default=200_000)

    p_render = sub.add_parser("render")
    p_render.add_argument("pdf")
    p_render.add_argument("--page", type=int, default=0)
    p_render.add_argument("--out", required=True)
    p_render.add_argument("--dpi", type=float, default=144.0)

    p_search = sub.add_parser("search")
    p_search.add_argument("pdf")
    p_search.add_argument("query")
    p_search.add_argument("--max-hits", type=int, default=50)

    args = ap.parse_args()

    if args.cmd == "check":
        cmd_check()
        return

    pdf = resolve_in(args.pdf, read_roots, repo, must_exist=True)

    if args.cmd == "info":
        cmd_info(pdf)
    elif args.cmd == "text":
        cmd_text(pdf, parse_pages(args.pages), args.max_chars)
    elif args.cmd == "render":
        out = Path(args.out).expanduser()
        if not out.is_absolute():
            out = (Path.cwd() / out).resolve()
        else:
            out = out.resolve()
        cmd_render(pdf, args.page, out, args.dpi, repo, write_roots)
    elif args.cmd == "search":
        cmd_search(pdf, args.query, args.max_hits)
    else:
        die(f"unknown cmd: {args.cmd}")


if __name__ == "__main__":
    main()
