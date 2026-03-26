---
"@cloudflare/vite-plugin": patch
"miniflare": patch
---

fix: WebSocket upgrades proxied through a node service binding no longer crash the dev server or silently fail

Previously, when a Worker forwarded a WebSocket upgrade request via a service binding backed by a node-style handler, miniflare would crash with an `AssertionError`. Even after preventing the crash, upgrades still silently failed because the request was routed through middleware that discards WebSocket upgrades.

Miniflare now strips the internal routing header during WebSocket upgrades to prevent the crash, and `@cloudflare/vite-plugin` dispatches WebSocket upgrades directly to the entry worker, bypassing the middleware chain entirely.
