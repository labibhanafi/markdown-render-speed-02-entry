# Faster Markdown rendering, byte-identical to marked

A dependency-free JavaScript Markdown renderer whose `parse(markdown)`
returns, for every input, exactly the HTML that **marked 18.1.3** returns
with its default options (GFM on) — only faster.

- `parse.js` — the module. `parse(markdown)` is the drop-in.
- `main.ts` — the harness program: reads `/input/cases.json`, renders each
  case with `parse`, writes `/output/html.json`.

## How it works

The grammar is marked's: a block phase scans the source with anchored rules
in marked's priority order (space, indented code, fences, ATX/setext
headings, thematic breaks, block quotes, lists, HTML blocks, link reference
definitions, GFM tables, paragraphs) while collecting link definitions, then
an inline phase renders each block's text using marked's delimiter-run
emphasis algorithm over a masked copy of the source, so emphasis and
strikethrough never reach inside links, code spans, raw HTML or escapes.

The speed is in the mechanics around that grammar:

- blocks and inline runs render straight to strings — no token tree, no
  separate parser pass;
- the inline scanner dispatches on the current character, and plain text is
  consumed by a single character sweep that stops exactly where another
  inline rule could start, instead of a lookahead cascade per position;
- the emphasis closer scan shared by every opener in a run is computed once
  per run, and openers with no possible closer ahead are skipped outright;
- expensive block rules (setext headings, tables, list continuation checks)
  sit behind cheap necessary-condition gates on the block's first
  characters, so the common path never pays for rules that cannot match;
- list line handling expands tabs only when a line actually contains one,
  and URL cleaning takes a fast path for the URLs that need no escaping.

Verified byte-identical to marked 18.1.3 on the competition's full practice
set (652 CommonMark 0.31.2 examples, 28 GFM 0.29 extension examples, 40
generated READMEs) and on thousands of generated and mutated documents.

## NOTICE

The Markdown grammar implemented in `parse.js` is derived from marked
18.1.3 (markedjs/marked, tag v18.1.3), which is MIT licensed:

Copyright (c) 2018-2026, MarkedJS. (MIT License)
Copyright (c) 2011-2018, Christopher Jeffrey. (MIT License)
https://github.com/markedjs/marked

marked's license text is included in this repository as `MARKED-LICENSE.txt`.
This project is not affiliated with MarkedJS; it is an independent
implementation built to match marked's output.

## License

MIT — see `LICENSE`.
