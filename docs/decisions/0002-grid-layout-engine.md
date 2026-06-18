# 0002 — Owned grid-layout engine over a drag-and-drop library

- **Status**: Accepted
- **Date**: 2026-06-17

## Context

The arena desktop needs draggable + resizable game windows that snap to a
column grid, push each other out of the way, and float up to fill gaps
(react-grid-layout behaviour). We evaluated three options against two
constraints: React 19, and "own the component like shadcn" (source in-repo,
styled with our tokens).

- **react-grid-layout** — most complete, but depends on `react-draggable`,
  which calls `ReactDOM.findDOMNode`. React 19 removed that function, so RGL
  throws at runtime; the fix is unmerged. It is also a class-based black box.
- **dnd-kit** — React-19-safe and strong at dragging (incl. keyboard a11y), but
  has no resize and no grid collision/compaction. Those — the hard parts — are
  hand-rolled regardless, so dnd-kit covers only the drag-delta math while
  adding a dependency and a second interaction model (its transform/overlay for
  drag vs. raw Pointer Events for resize).
- **gridstack.js** — capable and dep-free, but an imperative vanilla API with no
  first-class React wrapper.

## Decision

We hand-roll an owned grid engine. The pure layout math (collision, vertical
compaction, cascade push-down, move, resize) lives in `grid-layout-engine.ts`
with unit tests; the React surface in `grid-layout.tsx` drives drag and resize
through one uniform Pointer Events path, plus keyboard move/resize for a11y.

## Consequences

- Zero runtime dependencies; React-19-safe (no `findDOMNode`); the engine is
  pure and unit-tested in isolation.
- Drag and resize share one interaction model, and the component is styled with
  our semantic tokens so it fits both the arena and walrus themes.
- We own ongoing maintenance of layout behaviour (no upstream to inherit fixes
  from) and ship keyboard a11y ourselves rather than getting it from dnd-kit.
- We explicitly chose *not* to depend on react-grid-layout, dnd-kit, or
  gridstack for this component.
