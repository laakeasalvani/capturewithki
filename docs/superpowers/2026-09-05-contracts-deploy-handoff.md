# Contracts & payments — what happens before this goes live

Branch: `contracts-and-payments`. **Nothing deployed.**

> **The hand-load procedure has moved.** `functions/seed/` is deleted — its
> `packages.json` predated the package schema and produced packages
> `validatePackage` refuses forever, and its steps pointed at a template
> document id nothing looks up. The one correct procedure for loading the
> templates and packages into Firestore is
> `docs/superpowers/2026-09-08-contracts-handover.md`. Follow that, not this
> file, for anything to do with seeding.

Everything below was deliberately NOT done during the build, because
`capturewithki-69dd3` is production and there is no staging project. A subagent with
no context should never run a deploy against a live business; these are for a human
with the full picture.

## Blocked on Khiara, not on code

1. **Create the Stripe account.** Click-by-click steps are in the appendix of
   `docs/superpowers/specs/2026-09-04-contracts-and-payments-design.md`, written for
   her directly. Test-mode keys work the moment the account exists — only the final
   live charge waits on identity verification.
2. **Buy a contract.** A purchased photographer template or an Oregon attorney's
   review. Neither Laakea nor Claude writes the clauses. Templates are hand-loaded
   with `isDraft: true`, which a guard in `sendContract` makes physically unsendable
   until she has read the exact text — see
   `docs/superpowers/2026-09-08-contracts-handover.md`.
3. **Confirm the prices.** The live site's own markup says its pricing is fake —
   `index.html:110` ("Pricing is placeholder") and `index.html:693` ("PLACEHOLDER
   PRICING — replace every figure below before launch").
   `docs/superpowers/2026-09-08-contracts-handover.md` lists the nine packages
   needing her confirmed prices. Nothing may be loaded until she states real
   numbers, or clients sign contracts carrying invented figures.

## Deploy order — this sequence matters

1. **Create placeholder values for `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`
   FIRST.** `signContract`, `startRetainerPayment`, `stripeWebhook` and
   `chaseContracts` all DECLARE these, and Firebase refuses to deploy a function whose
   declared secret has no version. Without this the first deploy simply fails.
2. `firebase deploy --only firestore:rules --project capturewithki-69dd3`
3. In the Rules Playground, confirm: a signed contract allows a `status`-only update;
   denies a `totalCents` update; denies a `signature` update; an UNSENT contract
   allows anything; delete is denied always.
4. Load `contractTemplates/wedding`, `/elopement` and `/portrait` (each
   `isDraft: true`) and the `packages` documents — see
   `docs/superpowers/2026-09-08-contracts-handover.md`, whose section 1 gates the
   steps on answers only Khiara can give. The document ids are those three exact
   keys; `sendContract` looks templates up by `templateKey` and nothing else.
5. Deploy the functions.
6. **Before testing any legitimate webhook**, curl a forged signature at the deployed
   `stripeWebhook` and confirm **HTTP 400**. If that ever returns 200, anyone who
   finds the URL can mark contracts paid.
7. Confirm `apiVersion: '2024-06-20'` round-trips against `stripe@22.6.1`. Untestable
   without an account; the unit tests never touch that path.
8. Run the Puppeteer spike (plan 1, task 14) and then build or abandon the PDF per its
   result. Delete the spike function either way — a leftover callable that launches a
   browser is an open invitation to run up a bill.
9. End to end: send a contract to Laakea's own address, open it on a phone, sign it,
   pay through `/sign/fake-pay/`, and confirm the dashboard reads correctly at each
   step.
10. At Stripe go-live: set `PAYMENT_PROVIDER=stripe`, delete every contract with
    `isTestPayment == true`, and delete `sign/fake-pay/`.

## Build these next, in this order

1. **Void / cancel.** `canTransition` defines `sent→void` and `signed→cancelled`, and
   the dashboard renders badges for both — but **nothing in the codebase ever writes
   either value.** A client who cancels by phone therefore receives up to three
   dunning emails and Khiara has no control to stop it short of editing Firestore.
   The fix is one callable plus one button. This is the largest known gap.
2. **Resend a contract.** `draft→sent` is the only route to `sent`, and the Send
   control only appears for drafts, so a client who loses their email cannot be helped.
3. **The dashboard's paid state** (plan 2, task 7) — deferred because payment cannot
   happen until Stripe exists.

## Known limitations, by design

- **Reminder emails cannot link to the signing page.** Only the token's *hash* is
  stored, never the token. Reminders point back to the original email instead. Storing
  the raw token would be the wrong trade.
- **Installments are not built.** The site promises them at `index.html:964`; the
  schema leaves room. When built, Stripe Billing's scheduled invoices and dunning do
  the hard part — do not hand-roll retries.
- **Two identical audit rows are possible** under genuinely concurrent duplicate
  webhook deliveries. Accepted four times: both rows carry the same content, Stripe
  charges once regardless, and closing it means undoing the decide-don't-write split
  that makes `markContractPaid` testable without Firestore.
- **`index.js` has no unit tests**, matching this project's existing convention. The
  `lib/` modules carry all of them.
