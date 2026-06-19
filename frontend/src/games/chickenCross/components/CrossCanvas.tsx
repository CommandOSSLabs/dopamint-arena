import { useEffect, useRef } from "react";
import type { CrossView } from "../session-core.ts";
import type { CrossDir } from "../../../../../sui-tunnel-ts/src/protocol/cross.ts";
import { CrossScene } from "../scene/CrossScene.ts";
import { crossViewToSnapshot, initialFeeder, type FeederState } from "../scene/crossViewToSnapshot.ts";
import { bindCrossInput } from "../scene/crossInput.ts";
import { CrossSounds } from "../scene/crossSounds.ts";
import type { CrossDirection } from "../scene/crossSceneTypes.ts";

type CrossCanvasProps = {
  view: CrossView;
  role: "A" | "B" | null;
  winner: "A" | "B" | null;
  onDir: (dir: CrossDir) => void;
};

const SCREEN_DIRS: Array<{ dir: CrossDirection; glyph: string; col: string; row: string }> = [
  { dir: "north", glyph: "▲", col: "2", row: "1" },
  { dir: "west", glyph: "◀", col: "1", row: "2" },
  { dir: "east", glyph: "▶", col: "3", row: "2" },
  { dir: "south", glyph: "▼", col: "2", row: "3" },
];

export function CrossCanvas({ view, role, winner, onDir }: CrossCanvasProps) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const sceneRef = useRef<CrossScene | null>(null);
  const soundsRef = useRef<CrossSounds | null>(null);
  const prevViewRef = useRef<CrossView | null>(null);
  const feederRef = useRef<FeederState>(initialFeeder());
  const prevWinnerRef = useRef<"A" | "B" | null>(null);
  const emitRef = useRef<((d: CrossDirection) => void) | null>(null);
  const onDirRef = useRef(onDir);
  onDirRef.current = onDir;

  // Mount once: scene, sounds, input, resize observer, render loop.
  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;

    const scene = new CrossScene(canvas);
    const sounds = new CrossSounds();
    sceneRef.current = scene;
    soundsRef.current = sounds;
    scene.setCameraMode("3d");

    // screen dir -> world dir (iso-aware) -> setDir
    const emit = (screenDir: CrossDirection) => {
      const world = scene.worldDirectionFromScreenInput(screenDir);
      onDirRef.current(world as CrossDir);
    };
    const unbindInput = bindCrossInput(canvas, emit);
    emitRef.current = emit;

    const ro = new ResizeObserver((entries) => {
      const box = entries[0].contentRect;
      scene.resize(box.width, box.height);
    });
    ro.observe(wrap);
    scene.resize(wrap.clientWidth, wrap.clientHeight);

    sounds.play("room-join"); // match has started (CrossBoard only mounts during play)

    let raf = 0;
    const frame = () => {
      scene.render();
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      unbindInput();
      scene.dispose();
      sceneRef.current = null;
      soundsRef.current = null;
      emitRef.current = null;
      prevViewRef.current = null;
      feederRef.current = initialFeeder();
      prevWinnerRef.current = null;
    };
  }, []);

  // Keep the local-player focus in sync with role.
  useEffect(() => {
    sceneRef.current?.setLocalPlayerId(role);
  }, [role]);

  // Feed each tick + fire transition sounds.
  useEffect(() => {
    const scene = sceneRef.current;
    const sounds = soundsRef.current;
    if (!scene || !sounds) return;
    const { snapshot, feeder, events } = crossViewToSnapshot(
      view, prevViewRef.current, role, feederRef.current,
    );
    scene.applySnapshot(snapshot, role);
    feederRef.current = feeder;
    prevViewRef.current = view;
    if (events.hop) sounds.play("hop");
    for (const d of events.deaths) sounds.play(d);
  }, [view, role]);

  // Win sound on null -> winner transition.
  useEffect(() => {
    if (winner && !prevWinnerRef.current) soundsRef.current?.play("win");
    prevWinnerRef.current = winner;
  }, [winner]);

  const press = (dir: CrossDirection) => {
    soundsRef.current?.play("click");
    emitRef.current?.(dir);
  };

  return (
    <div ref={wrapRef} className="cross-canvas-wrap">
      <canvas ref={canvasRef} className="cross-canvas" />
      <div className="cross-dpad" role="group" aria-label="move">
        {SCREEN_DIRS.map((b) => (
          <button
            key={b.dir}
            type="button"
            className="cross-dpad-btn"
            style={{ gridColumn: b.col, gridRow: b.row }}
            aria-label={b.dir}
            onClick={() => press(b.dir)}
          >
            {b.glyph}
          </button>
        ))}
      </div>
    </div>
  );
}
