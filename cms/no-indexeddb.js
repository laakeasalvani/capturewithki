// Loaded as a plain (non-module) script in the <head> of the pages CLIENTS
// open — galleries/ and sign/ — so it runs before Firebase starts.
//
// Firebase reads IndexedDB before it sends anything: Auth to restore a saved
// login, and every request to attach a usage "heartbeat". Safari has a
// long-standing bug where IndexedDB stops answering — worst after a page has
// used a lot of memory, which saving a gallery to Photos does. When that
// happens nothing errors; the page just waits forever. On 2026-09-29 a new
// gallery sat on "Checking…" and the password never even left the phone.
//
// These pages keep nothing in IndexedDB — a client types the password every
// visit — so hiding it costs nothing, and Firebase falls back to memory
// instead of waiting on a database that may never reply. Reproduced and
// verified in .claude/preview/idb-hang-*.html.
//
// NOT for the CMS or the dashboard: those keep Khiara signed in across visits.
try {
  Object.defineProperty(window, 'indexedDB', { value: undefined, configurable: true });
} catch (err) { /* cannot happen in a modern browser; if it does, nothing changes */ }
