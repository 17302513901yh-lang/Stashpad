# Decision: a local review page (stashpad ui)

Status: built. Tested on Linux in a headless browser. Windows and macOS run the same tests in CI.

## Why

Accepting or rejecting a waiting memory was only possible in the terminal. The review queue is the
promise that nothing an agent writes lands in the store without a person. A page makes that step visible:
what waits, where it came from, what it may conflict with, and what accepting it does.

## How it stays safe

- **Localhost only.** The server listens on 127.0.0.1 and answers only to the host names 127.0.0.1 and localhost.
  A web page that rebinds a name to this computer gets a 403.
- **A token per run.** Every API call needs a random token. It is given only inside the page the server serves.
  A page from another site cannot read the store, because it cannot read the response and cannot send the token.
- **No HTML from the store.** The page builds everything with text nodes. A test checks that the script never
  uses innerHTML or similar. A memory that contains HTML is shown as plain text.
- **Strict content policy.** Scripts and styles come only from this server. No inline scripts, no external resources.
- **JSON only for changes.** A write needs a JSON body; other content types get 415. Bodies over 64 KB are refused.
- **Same rules as the command line.** Accepting and rejecting call the same store functions, so the secret check,
  the reserved ids and the audit log all apply.

## Limits

- It is a single-user page for the computer it runs on. It is not a sharing service.
- It is started by hand (`stashpad ui`) and stops with Ctrl+C. It does not run in the background.
- No installer. A desktop app (.exe, .dmg) needs code signing and is left for after publication.
