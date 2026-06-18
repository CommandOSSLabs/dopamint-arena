import gsap from "gsap";

/**
 * macOS-style dock flights for minimize/restore. A throwaway "ghost" of the
 * window (its logo) is animated with GSAP so it never fights React's mount/
 * unmount. Both flights no-op under prefers-reduced-motion.
 */

const reducedMotion = () =>
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

type Point = { x: number; y: number };

/** A fixed, pointer-transparent clone of the window showing its logo. */
function makeGhost(rect: DOMRect, image: string): HTMLDivElement {
  const ghost = document.createElement("div");
  ghost.style.cssText = `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;z-index:60;border-radius:12px;overflow:hidden;pointer-events:none;box-shadow:0 12px 48px rgba(0,0,0,.45);background:var(--card);will-change:transform,opacity`;
  if (image) {
    const img = document.createElement("img");
    img.src = image;
    img.style.cssText = "width:100%;height:100%;object-fit:cover";
    ghost.appendChild(img);
  }
  document.body.appendChild(ghost);
  return ghost;
}

/** Where the dock sits — the live dock if present, else the edge it appears on. */
function dockTarget(macDockSide: "right" | "bottom"): Point {
  const dock = document.querySelector("[data-mac-dock]");
  if (dock) {
    const d = dock.getBoundingClientRect();
    return { x: d.left + d.width / 2, y: d.top + d.height / 2 };
  }
  return macDockSide === "right"
    ? { x: window.innerWidth - 48, y: window.innerHeight * 0.45 }
    : { x: window.innerWidth * 0.4, y: window.innerHeight - 56 };
}

/** Minimize: shrink the window's ghost into the dock, ending as a round tile. */
export function flyToDock(
  sourceEl: HTMLElement,
  image: string,
  macDockSide: "right" | "bottom",
): void {
  if (reducedMotion()) return;
  const rect = sourceEl.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const t = dockTarget(macDockSide);
  const ghost = makeGhost(rect, image);
  gsap.to(ghost, {
    x: t.x - (rect.left + rect.width / 2),
    y: t.y - (rect.top + rect.height / 2),
    scale: 0.06,
    opacity: 0,
    borderRadius: "9999px",
    duration: 0.4,
    ease: "power2.in",
    onComplete: () => ghost.remove(),
  });
}

/**
 * Restore: grow a ghost from the dock slot (`sourceRect`) up to where the window
 * has just re-appeared (`targetEl`), then dissolve into it.
 */
export function flyFromDock(
  targetEl: HTMLElement,
  image: string,
  sourceRect: DOMRect,
): void {
  if (reducedMotion()) return;
  const rect = targetEl.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const ghost = makeGhost(rect, image);
  const dx =
    sourceRect.left + sourceRect.width / 2 - (rect.left + rect.width / 2);
  const dy =
    sourceRect.top + sourceRect.height / 2 - (rect.top + rect.height / 2);
  gsap
    .timeline({ onComplete: () => ghost.remove() })
    .fromTo(
      ghost,
      {
        x: dx,
        y: dy,
        scale: Math.max(0.06, sourceRect.width / rect.width),
        opacity: 1,
        borderRadius: "9999px",
      },
      {
        x: 0,
        y: 0,
        scale: 1,
        borderRadius: "12px",
        duration: 0.36,
        ease: "power3.out",
      },
    )
    .to(ghost, { opacity: 0, duration: 0.12 }, "-=0.08");
}
