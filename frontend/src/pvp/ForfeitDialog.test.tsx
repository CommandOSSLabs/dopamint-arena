// Radix `Dialog` renders `DialogContent` into a portal (document.body), so
// `renderToStaticMarkup` can't see the copy — it never touches the DOM. Render into jsdom via
// @testing-library/react instead (same pattern as ChatWindow.test.tsx): portal content lands in
// document.body, so `screen` queries find it like any other rendered element.
import "global-jsdom/register";
// global-jsdom only copies jsdom globals that Node doesn't already define (see its `!(k in
// global)` filter), so Node's built-in Event/CustomEvent/EventTarget survive instead of jsdom's.
// Radix's DismissableLayer constructs a `CustomEvent` and dispatches it on jsdom's `document`,
// which requires an instance from its own realm — patch these three from `window` so they match.
global.CustomEvent = window.CustomEvent;
global.Event = window.Event;
global.EventTarget = window.EventTarget;
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { render, screen, cleanup } from "@testing-library/react";
import { ForfeitDialog } from "./ForfeitDialog.tsx";

// node:test has no built-in DOM-cleanup hook (unlike jest/vitest's testing-library preset), and a
// leftover open Dialog's portal + focus-trap/aria-hidden observers collide with the next render —
// unmount after every test or the second render hangs.
afterEach(() => cleanup());

test("ForfeitDialog renders the exact copy with the stake when open", () => {
  render(
    <ForfeitDialog
      open
      stake="100 MTPS"
      onKeepPlaying={() => {}}
      onForfeit={() => {}}
    />,
  );

  assert.ok(screen.getByText("Forfeit this match?"));
  // The stake is interpolated mid-sentence, so the description is split across sibling text
  // nodes — query the description element directly instead of a substring text matcher (every
  // ancestor's aggregate textContent would also "include" the phrase and over-match).
  const description = document.querySelector(
    '[data-slot="dialog-description"]',
  );
  assert.ok(description?.textContent?.includes("your 100 MTPS stake is gone"));
  assert.ok(screen.getByText("Keep playing"));
  assert.ok(screen.getByText("Forfeit & leave"));
});

test("ForfeitDialog renders nothing when closed", () => {
  render(
    <ForfeitDialog
      open={false}
      stake="100 MTPS"
      onKeepPlaying={() => {}}
      onForfeit={() => {}}
    />,
  );

  assert.equal(screen.queryByText("Forfeit this match?"), null);
});
