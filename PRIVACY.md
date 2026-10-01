# Privacy

Jev Gmail Classifier is a local Chrome extension. It has no backend of its own, no analytics, and no telemetry. Every network request goes from your browser to the provider you configure, using the API key you supply. This document describes exactly what leaves the browser, where it goes, what is stored, and how to delete it.

## What leaves the browser

For each classified Gmail row, the extension builds a Jev `state` and sends it to the provider you chose:

- The sender's display name.
- The sender's email address — or `***@domain` when privacy mode is on.
- The subject line.
- A cleaned one-line snippet, with quoted replies, signatures, and unsubscribe footers stripped out.
- The date as Gmail renders it (for example `9:41 AM` or `Sep 3`).

The email's local id/hash and its unread flag are **not** sent.

Alongside the `state`, every request includes the question set:

- Your category names and descriptions, sent as the Choice `criteria` so the model can pick a category.
- The three priority level descriptions, sent as the Score `criteria`.
- The two Noul questions with their true/false criteria: whether the mail is spam, and whether it needs a reply.

### Deep mode (opt-in)

With **deep mode** enabled, an ambiguous row is re-classified after you open it. In that pass the opened message body is also sent. The body is passed through the same quote/signature stripping as a snippet and then truncated to **4000 characters**.

Attachments and images are never read, so they can never leave the browser. A message body is not sent unless deep mode is enabled and you open the message.

### Privacy mode

Enabling **privacy mode** reduces what is sent:

- The sender display name is omitted.
- The sender address is reduced to `***@domain`.
- The snippet is truncated to 120 characters.

## Where it goes

Only to the provider you selected in the popup, over HTTPS, under your own key:

- TypeSafe direct: `https://api.typesafe.ai/v1/systemone`
- Vercel AI Gateway (TypeSafe-compatible): `https://ai-gateway.vercel.sh/typesafe/v1/systemone`

No other hosts are contacted. The extension's `host_permissions` are limited to `https://mail.google.com/*`, `https://api.typesafe.ai/*`, and `https://ai-gateway.vercel.sh/*`; it requests only the `storage` permission.

## Your API key

- The key is stored in `chrome.storage.local`, one entry per provider, under `key:typesafe` or `key:vercel-gateway`.
- It is read **only** by the extension's service worker. The content script that runs on the Gmail page never reads it and makes no network calls.
- The key is never sent anywhere except as the `Authorization: Bearer <key>` header of requests to the provider you selected.
- The key is never logged.
- The popup and options pages only ever show the last 4 characters of a saved key; the full value is never rendered.

## What is stored locally

In `chrome.storage.local`:

- Your settings: provider, categories, thresholds, privacy mode, deep mode, group-by-priority, and classify-unread-only.
- Your API key (see above).
- A bounded LRU classification cache, maximum 5000 entries. Each entry is keyed by a stable hash of sender address + subject + date and holds the classification result, so repeat rows are not re-sent.

The cache is invalidated when the provider, categories, thresholds, or privacy mode change. Nothing else is stored.

## Email content is untrusted data

Gmail content (sender, subject, snippet, and in deep mode the body) is passed to Jev strictly as **data**. It is never interpreted as instructions, prompts, or code. Chip text is written with `textContent`, so email content cannot inject HTML or scripts into the Gmail page.

## No analytics or backend

- No analytics, no telemetry, no crash reporting, and no servers operated by this project.
- The only network traffic is the provider request described above.
- The extension never archives, deletes, labels, or sends mail.

## How to delete your data

- Remove a key with **Remove** in the popup (per provider).
- Clear the classification cache with **Clear cache** in the popup or the options page.
- Uninstalling the extension removes its `chrome.storage.local` data.

## Third parties

When a request is sent, the provider's own data handling applies. See the current terms for each:

- TypeSafe: <https://docs.typesafe.ai/legal>
- Vercel AI Gateway: <https://vercel.com/docs/ai-gateway>

## Warning

Your category names and descriptions are sent to the provider with every request. Do not put sensitive information in a category name or description.
