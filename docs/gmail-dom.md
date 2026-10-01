# Gmail DOM notes

Gmail does not provide a supported API for its page markup. There is no contract that guarantees a given element, class, or attribute will keep its name, meaning, or position. To read the message list, this extension therefore depends on **undocumented selectors** that can change at any time.

Every Gmail selector is isolated in the `SELECTORS` object in `src/content/gmail-dom.ts`; no other file should contain one. When Gmail changes, this is the file to update (see [How to fix when Gmail changes](#how-to-fix-when-gmail-changes)).

## Selectors

`SELECTORS` is an object whose values are ordered arrays of CSS selectors, most specific first. For each field, the first selector in the array that matches is used; the later entries are fallbacks.

| Purpose | Selector(s), most specific first |
| --- | --- |
| Message list rows | `tr.zA` |
| List container (scopes the `MutationObserver`) | `table.F.cf.zt`, `div[role="main"] table`, `div[gh="tl"]` |
| Sender (address in its `email` attribute; text is the display name) | `span[email]`, `.yW span[email]`, `.yX span[email]` |
| Subject line | `.bog`, `.y6 span.bog`, `span.bog` |
| One-line preview / snippet | `.y2`, `span.y2` |
| Date cell (the inner span often carries a full timestamp in its `title`) | `.xW span`, `td.xW span`, `.xW` |
| Opened message body (deep mode only) | `div.a3s` |

How the selectors are resolved:

- `firstMatch(root, selectors)` returns the first element matching the first selector that matches anything. Used for `sender`, `subject`, `snippet`, and `date`.
- `allMatches(root, selectors)` returns all elements from the first selector that matches anything. Used for `row` (`getRows()`), `list` (`getListRoot()`), and `body` (`readOpenBody()`).
- `readRow(row)` reads the sender from the sender element's `email` attribute (address) and its text (name), the subject and snippet text, and the date from the date element's `title` attribute, falling back to its text. All text is whitespace-collapsed.
- `isUnread(row)` is true when the row has the `zE` class or contains a `.zE` element.
- `getListRoot()` falls back to `document.body` in `content.ts` when no list container matches, so the observer still runs.
- `readOpenBody(root)` returns the text of the **last** `div.a3s` in the document — the currently opened message — or `null` if none is present.

## Row identity: `rowThreadId`

`rowThreadId(row)` returns the first of these that is present, in order:

1. `data-legacy-thread-id` (attribute)
2. `data-thread-id` (attribute)
3. `id` (attribute)

The value is used only as a stable element key/id hint. If none is present, identity falls back to a stable hash of sender address + subject + date (`computeEmailHash` in `src/shared/metadata.ts`), which is also the LRU cache key. Because the hash drives the cache, the Gmail id is a hint, not the source of truth.

## Failure handling

Failure is designed to be graceful, never fatal:

- `readRow(row)` returns `null` when it finds **no sender email, no sender name, and no subject** (a missing individual field is just an empty string). The caller skips that row instead of throwing, so one odd row cannot break the list.
- `selectorsLookBroken()` returns `true` when Gmail's list shell exists (`div[role="main"]` is present) but `getRows()` returns **zero** rows. This is the signal that the `row` selector or the list structure has changed.
- `content.ts` counts consecutive broken scans (`brokenStreak`). After `BROKEN_WARN_AFTER` (4) in a row, it shows the status-bar warning once:

  > Gmail markup not recognised; chips are paused. See docs/gmail-dom.md.

  Chips already rendered on previously classified rows are left in place. The extension does not throw and does not reload or modify the page.

The status bar itself is always injected with the `jvc-` prefix and rendered with `textContent`, so Gmail markup and email content are never executed.

## How to fix when Gmail changes

Symptoms: no new chips, and (if the list shell is still present) the “Gmail markup not recognised” warning after four scans.

1. Open Gmail in Chrome with the extension loaded and open DevTools (F12).
2. Inspect the element that broke. Right-click the row (or the sender/subject/snippet/date) and choose **Inspect**. In the Elements panel, prefer stable attributes (`[email]`, `[data-*]`, `role=`) over generated utility classes.
3. Update `SELECTORS` in `src/content/gmail-dom.ts`: add the new selector at the **front** of the relevant array and keep the old entries as fallbacks where they still match. Do not put selectors anywhere else.
4. Rebuild: `npm run build`.
5. Reload the extension at `chrome://extensions` (the reload icon on the extension card) and reload the Gmail tab.
6. Confirm chips reappear and the warning stops.
7. Update the selector table above in the same change.

For selector work without touching real Gmail, use `dev/demo.html` — a zero-network harness (a fake Gmail list with a stub `chrome` API and canned answers) that uses the same `tr.zA` / `.bog` / `.y2` / `.xW` structure. Open it in Chrome after `npm run build`.
