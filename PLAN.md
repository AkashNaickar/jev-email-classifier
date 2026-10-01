# PLAN — Jev Gmail Classifier (Chrome MV3)

## 0. Verified API facts (source of truth)

All fields below were confirmed against the official docs, **not invented**.

- **TypeSafe (direct):** `POST https://api.typesafe.ai/v1/systemone`
  - Header: `Authorization: Bearer <TYPESAFE_API_KEY>`, `Content-Type: application/json`
  - Body: `{ "state": <string|object|array>, "model": "jev-latest", "questions": { <id>: <Question> } }`
  - Noul question: `{ type: "noul", instructions, criteria?: { true, false } }` → answer `{ type, noul }` (P(yes), 0–1)
  - Choice question: `{ type: "choice", instructions, criteria: { option: description|null } }` (≤255) → answer `{ type, choice, confidence, probabilities }`
  - Score question: `{ type: "score", instructions, criteria: [level...] }` (2–10) → answer `{ type, score, confidence, legend, probabilities }`
  - Response: `{ model, answers: { <id>: <Answer> }, usage: { input_tokens, output_tokens } }`
  - Errors: `401`, `422`, `429`, `529`; retry 429/529 with exponential backoff, honor `retry-after`.
- **Vercel AI Gateway (TypeSafe-compatible API):** `POST https://ai-gateway.vercel.sh/typesafe/v1/systemone`
  - Same request/response shape; `model` is `typesafe-ai/jev`; auth is the AI Gateway key.
  - Response adds `provider_metadata.gateway.cost` (string USD) and routing metadata.
  - (`GET https://ai-gateway.vercel.sh/typesafe/v1/models` lists models.)
- **Limits:** request ctx 64k tokens; state + longest question ≤32k; 40 req/s; 100k tok/s.
- **Price:** $0.042 per 1M input tokens; output tokens free. Used for the cost estimate.
- **Note:** Gateway also exposes a newer native `POST /v1/evaluate` with `type: "boolean"` and
  `probability`. We deliberately use the **TypeSafe-compatible** path instead because it returns the
  same native `noul`/`choice`/`score` fields as direct TypeSafe, so one question builder and one
  parser serve both providers.

## 1. Design decisions

- **One Jev request per email.** A Jev `state` is a single piece of content; questions are evaluated
  against that one state. We classify one email per request with 4 questions (category Choice,
  priority Score, spam Noul, needs-reply Noul). "Batching" = a concurrency-limited queue with
  debounce, not multiple emails in one state (avoids key explosion and cross-email bleed).
- **Metadata only by default:** sender name, sender address, subject, snippet (quotes/signature
  stripped), date. Deep mode (opt-in) re-classifies ambiguous rows with the opened body.
- **Read-only.** Never archive/delete/label/send. On-screen priority grouping uses CSS
  `transform: translateY()` only, never DOM reordering, so Gmail clicks/selection keep landing on the
  visible row.
- **Cache** in `chrome.storage.local`, keyed by a stable hash of sender+subject+date, LRU-bounded to
  5000 entries, invalidated when provider or categories change.

## 2. File tree

```
manifest.json            (in public/, copied to dist/)
package.json  tsconfig.json  vitest.config.ts  .gitignore
scripts/build.mjs        esbuild multi-entry -> dist/
scripts/gen-icons.mjs    pure-Node PNG encoder (no deps)
src/shared/
  types.ts               frozen message protocol + domain types
  defaults.ts            default categories/settings
  questions.ts           settings -> Jev questions; answers -> Classification
  parse.ts               response parsing + schema guards
  cache.ts               LRU cache (pure core + storage wrapper)
  queue.ts               concurrency + retry/backoff (pure)
  metadata.ts            email metadata extraction, snippet cleanup, stable hash
  cost.ts                token -> USD estimate
  provider.ts            Provider interface + TypeSafeProvider + VercelGatewayProvider
  util.ts                small helpers
src/background/service-worker.ts    key owner, queue, cache, status broadcasts
src/content/
  gmail-dom.ts           ALL Gmail selectors, isolated + documented
  content.ts             DOM read, chip injection, observer, status bar, grouping
  styles.css             chips + status bar
src/popup/popup.html popup.ts
src/options/options.html options.ts
dev/demo.html            fake Gmail list + stub chrome + canned answers
tests/*.test.ts
fixtures/emails.json     ~30 labeled synthetic emails
scripts/eval.ts          runs classifier over fixtures; accuracy + confusion matrix
docs/gmail-dom.md  PLAN.md  PRIVACY.md  README.md
```

## 3. Data flow

```
Gmail page                         Service worker (owns key)
-----------                        -------------------------
content.ts
  MutationObserver (throttled) ──► CLASSIFY {emails[]}
  reads rows via gmail-dom.ts            │
                                         ├─ cache lookup (chrome.storage.local)
                                         ├─ queue (concurrency 4, retry/backoff)
                                         ├─ Provider.callJev() ──► TypeSafe / Gateway
                                         └─ parse -> Classification
  render chips ◄────────────── CLASSIFY_RESULT {results[], errors[]}
  status bar   ◄────────────── STATUS {classified, inFlight, errors, cost}
```

Popup/options ⇄ worker: `GET_SETTINGS`, `SET_SETTINGS`, `SET_KEY`, `TEST_CONNECTION`, `CLEAR_CACHE`,
`CACHE_STATS`, `KEY_STATUS`.

## 4. Message protocol (frozen — `src/shared/types.ts`)

See the file for the exact discriminated unions: `ContentToBackground`, `UiToBackground`,
`BackgroundToContent`, plus `EmailMetadata`, `Classification`, `Category`, `Settings`, `StatusStats`.

## 5. Classification output

| Output | Jev primitive |
| --- | --- |
| `category` | Choice over user categories (one option per category id) |
| `priority` (Low/Med/High) | Score with 3 descriptive levels, normalised 0–1 |
| `spam_probability` | Noul |
| `needs_reply_probability` | Noul |
| confidence / `Uncertain` | Choice `confidence` vs user threshold |

## 6. Security checklist

- Key only in `chrome.storage.local`; read only by the service worker; popup shows last 4 chars.
- Permissions: `storage`, host `https://mail.google.com/*`, hosts
  `https://api.typesafe.ai/*` and `https://ai-gateway.vercel.sh/*`. No `<all_urls>`, no eval, no remote code.
- Chip text rendered with `textContent`; email content is data, never instructions/HTML.
- No telemetry, no backend. `PRIVACY.md` documents exactly what leaves the browser.

## 7. Build order (verified in small steps)

scaffold → shared core + tests → service worker → content script on demo page → real Gmail
selectors → popup/options → fixtures + eval → docs → final verify.
