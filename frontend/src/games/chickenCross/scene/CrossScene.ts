import type { CrossHazardSnapshot, CrossSnapshot } from "./crossSceneTypes.ts";
import type { CrossDirection, CrossLaneType, CrossPlayerState } from "./crossSceneTypes.ts";
import * as THREE from 'three';
import { crossFacingYaw } from './facing.ts';
import { worldDirectionForScreenInput } from './screenInput.ts';
import { CROSS_COLUMN_COUNT, CROSS_HOP_MS } from './crossSceneConstants.ts';

const TILE = 1.12;
const LANE_DEPTH = 1.0;
const CAMERA_FRUSTUM = 9;
const CAMERA_LERP = 0.12;
const LOG_RIDE_LERP = 0.42;
const HOP_LERP = 14;
const FACING_LERP = 12;

const COLORS = {
  sand: 0xe8a84c,
  sandDark: 0xd4953a,
  grass: 0x6fbf4a,
  grassDark: 0x4fa838,
  road: 0x4a4a52,
  roadMark: 0xe8e0c8,
  water: 0x3eb8d4,
  waterDeep: 0x2a9ab8,
  railsBed: 0x5c5048,
  railMetal: 0x888899,
  railTie: 0x4a3828,
  car: 0x9b6dff,
  carWindow: 0xb8e8ff,
  trainEngine: 0xc62828,
  trainCar: 0x1565c0,
  trainWindow: 0xffee88,
  log: 0x7a4f2a,
  chicken: 0xfff8f0,
  chickenShadow: 0xe8e0d8,
  comb: 0xff3b4d,
  beak: 0xffa726,
  eye: 0x1a1a1a,
  wing: 0xf0ece4,
  treeLeaf: 0x5cb85c,
  treeTrunk: 0x8b5a2b,
  arrow: 0xffe566,
};

type PlayerVisual = {
  group: THREE.Group;
  from: THREE.Vector3;
  to: THREE.Vector3;
  hopStart: number;
  facingYaw: number;
  facingGoal: number;
  lastLane: number;
  lastDiscreteCol: number;
  ridingLog: boolean;
  baseScale: number;
};

export class CrossScene {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.OrthographicCamera;
  private readonly worldGroup = new THREE.Group();
  private readonly playersGroup = new THREE.Group();
  private readonly backdrop = new THREE.Mesh();
  private readonly sceneryGroup = new THREE.Group();
  private readonly laneMeshes = new Map<number, THREE.Group>();
  private readonly hazardMeshes = new Map<string, THREE.Object3D>();
  private readonly playerVisuals = new Map<string, PlayerVisual>();
  private readonly grassTexture = CrossScene.createGrassTexture();
  private readonly dimGrassTexture = CrossScene.createDimGrassTexture();
  private localPlayerId: string | null = null;
  private cameraMode: '3d' | 'direct' = '3d';
  private cameraFocus = new THREE.Vector3();
  private cameraGoal = new THREE.Vector3();
  private lastSnapshot: CrossSnapshot | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    // Initial size of 1×1 — CrossCanvas calls resize() immediately via ResizeObserver.
    this.renderer.setSize(1, 1, false);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xc9e8f5);
    this.scene.fog = new THREE.Fog(0xc9e8f5, 32, 58);

    // Camera frustum is corrected by resize() on first mount; use placeholder aspect 1.
    this.camera = new THREE.OrthographicCamera(
      -CAMERA_FRUSTUM / 2,
      CAMERA_FRUSTUM / 2,
      CAMERA_FRUSTUM / 2,
      -CAMERA_FRUSTUM / 2,
      0.1,
      200,
    );

    const sun = new THREE.DirectionalLight(0xfff4e0, 1.15);
    sun.position.set(8, 22, 10);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -30;
    sun.shadow.camera.right = 30;
    sun.shadow.camera.top = 30;
    sun.shadow.camera.bottom = -30;
    this.scene.add(sun);
    this.scene.add(new THREE.AmbientLight(0x99aacc, 0.7));
    this.scene.add(new THREE.HemisphereLight(0x87ceeb, 0xe8a84c, 0.45));

    this.backdrop.geometry = new THREE.PlaneGeometry(180, 180);
    this.backdrop.rotation.x = -Math.PI / 2;
    this.backdrop.position.y = -0.2;
    this.dimGrassTexture.repeat.set(32, 32);
    this.backdrop.material = new THREE.MeshLambertMaterial({
      color: 0xffffff,
      map: this.dimGrassTexture,
    });
    this.backdrop.receiveShadow = true;
    this.scene.add(this.backdrop);

    this.buildWildernessScenery();
    this.scene.add(this.sceneryGroup);
    this.scene.add(this.worldGroup);
    this.scene.add(this.playersGroup);

    // No window resize listener — the container's ResizeObserver calls resize().
    this.resetCamera();
  }

  setLocalPlayerId(id: string | null): void {
    this.localPlayerId = id;
  }

  setCameraMode(mode: '3d' | 'direct'): void {
    this.cameraMode = mode;
  }

  /** Maps screen-left/right keys to grid west/east for the current camera angle. */
  worldDirectionFromScreenInput(logical: CrossDirection): CrossDirection {
    return worldDirectionForScreenInput(this.camera, logical);
  }

  /** Resize the renderer and recompute the ortho frustum from the container dimensions. */
  resize(width: number, height: number): void {
    const w = Math.max(1, width);
    const h = Math.max(1, height);
    const dpr = Math.min(typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1, 2);
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, false);
    const aspect = w / h;
    this.camera.left = (-CAMERA_FRUSTUM * aspect) / 2;
    this.camera.right = (CAMERA_FRUSTUM * aspect) / 2;
    this.camera.top = CAMERA_FRUSTUM / 2;
    this.camera.bottom = -CAMERA_FRUSTUM / 2;
    this.camera.updateProjectionMatrix();
  }

  getLocalPlayerWorldPosition(): THREE.Vector3 | null {
    if (!this.localPlayerId) return null;
    const visual = this.playerVisuals.get(this.localPlayerId);
    return visual ? visual.group.position.clone() : null;
  }

  getLocalPlayerRotationY(): number | null {
    if (!this.localPlayerId) return null;
    return this.playerVisuals.get(this.localPlayerId)?.group.rotation.y ?? null;
  }

  getLocalPlayerScreenPosition(): { x: number; y: number } | null {
    const world = this.getLocalPlayerWorldPosition();
    if (!world) return null;
    this.camera.updateMatrixWorld();
    const projected = world.clone().project(this.camera);
    const { clientWidth: w, clientHeight: h } = this.renderer.domElement;
    return {
      x: (projected.x * 0.5 + 0.5) * w,
      y: (-projected.y * 0.5 + 0.5) * h,
    };
  }

  getSceneryChildCount(): number {
    return this.sceneryGroup.children.length;
  }

  getLocalPlayerFromSnapshot(): CrossPlayerState | null {
    if (!this.lastSnapshot || !this.localPlayerId) return null;
    return this.lastSnapshot.players.find((player) => player.id === this.localPlayerId) ?? null;
  }

  applySnapshot(snapshot: CrossSnapshot, localPlayerId: string | null): void {
    this.lastSnapshot = snapshot;
    this.localPlayerId = localPlayerId ?? this.localPlayerId;

    for (const lane of snapshot.world.lanes) {
      this.ensureLaneMesh(lane.index, lane.kind);
    }

    const activeLaneIds = new Set(snapshot.world.lanes.map((lane) => lane.index));
    for (const laneId of [...this.laneMeshes.keys()]) {
      if (!activeLaneIds.has(laneId)) {
        this.worldGroup.remove(this.laneMeshes.get(laneId)!);
        this.laneMeshes.delete(laneId);
      }
    }

    const activeHazards = new Set<string>();
    for (const lane of snapshot.world.lanes) {
      for (const hazard of lane.hazards) {
        activeHazards.add(hazard.id);
        this.syncHazard(hazard);
      }
    }
    for (const [id, mesh] of this.hazardMeshes) {
      if (!activeHazards.has(id)) {
        this.worldGroup.remove(mesh);
        this.hazardMeshes.delete(id);
      }
    }

    const activePlayers = new Set(snapshot.players.map((player) => player.id));
    for (const player of snapshot.players) {
      const laneKind = snapshot.world.lanes.find((lane) => lane.index === player.laneIndex)?.kind;
      this.syncPlayer(player, laneKind === 'water');
    }
    for (const [id, visual] of this.playerVisuals) {
      if (!activePlayers.has(id)) {
        this.disposeVisual(visual);
        this.playersGroup.remove(visual.group);
        this.playerVisuals.delete(id);
      }
    }

    const focus =
      snapshot.players.find((player) => player.id === this.localPlayerId) ?? snapshot.players[0];
    if (focus) {
      this.cameraGoal.copy(this.gridToWorld(focus.column, focus.laneIndex));
      this.cameraGoal.y = 0;
    }
  }

  render(): void {
    const now = performance.now();

    this.cameraFocus.lerp(this.cameraGoal, CAMERA_LERP);
    const centerX = ((CROSS_COLUMN_COUNT - 1) * TILE) / 2;
    if (this.cameraMode === '3d') {
      this.camera.position.set(centerX + 6, 12, this.cameraFocus.z - 8);
      this.camera.lookAt(centerX - 1, 0, this.cameraFocus.z + 2);
    } else {
      this.camera.position.set(centerX, 14, this.cameraFocus.z - 6);
      this.camera.lookAt(centerX, 0, this.cameraFocus.z + 0.5);
    }

    this.backdrop.position.set(this.cameraFocus.x, -0.18, this.cameraFocus.z);
    // sceneryGroup is anchored at world origin — generated once across full match range.

    for (const visual of this.playerVisuals.values()) {
      const hopProgress = Math.min(1, (now - visual.hopStart) / CROSS_HOP_MS);
      if (visual.ridingLog) {
        visual.group.position.lerp(visual.to, LOG_RIDE_LERP);
        visual.group.position.y = visual.to.y + 0.02;
        const idleBob = Math.sin(now * 0.004) * 0.04;
        visual.group.scale.set(visual.baseScale, visual.baseScale + idleBob, visual.baseScale);
      } else {
        const t = Math.min(1, ((now - visual.hopStart) / CROSS_HOP_MS) * HOP_LERP);
        const eased = 1 - (1 - t) ** 3;
        visual.group.position.lerpVectors(visual.from, visual.to, eased);
        const hopArc = Math.sin(eased * Math.PI);
        visual.group.position.y = visual.to.y + hopArc * 0.35;
        // Squash-stretch: launch squash (compressed) → mid-air stretch → landing squash.
        const launchSquash = Math.sin(hopProgress * Math.PI);
        const stretchY = 1 + launchSquash * 0.22;
        const squashXZ = 1 - launchSquash * 0.12;
        visual.group.scale.set(
          visual.baseScale * squashXZ,
          visual.baseScale * stretchY,
          visual.baseScale * squashXZ,
        );
      }

      const facingT = Math.min(1, ((now - visual.hopStart) / CROSS_HOP_MS) * FACING_LERP);
      visual.facingYaw = THREE.MathUtils.lerp(visual.facingYaw, visual.facingGoal, facingT);
      visual.group.rotation.y = visual.facingYaw;
    }

    this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    this.scene.traverse((obj) => {
      const mesh = obj as unknown as {
        geometry?: { dispose?: () => void };
        material?: { map?: { dispose?: () => void }; emissiveMap?: { dispose?: () => void }; dispose?: () => void } | Array<{ map?: { dispose?: () => void }; emissiveMap?: { dispose?: () => void }; dispose?: () => void }>;
      };
      mesh.geometry?.dispose?.();
      if (Array.isArray(mesh.material)) {
        for (const m of mesh.material) {
          m?.map?.dispose?.();
          m?.emissiveMap?.dispose?.();
          m?.dispose?.();
        }
      } else {
        mesh.material?.map?.dispose?.();
        mesh.material?.emissiveMap?.dispose?.();
        mesh.material?.dispose?.();
      }
    });
    this.laneMeshes.clear();
    this.hazardMeshes.clear();
    this.playerVisuals.clear();
    this.grassTexture.dispose();
    this.dimGrassTexture.dispose();
    this.renderer.dispose();
  }

  /** Dispose all GPU resources owned by a player visual (geometries, materials, textures). */
  private disposeVisual(visual: PlayerVisual): void {
    visual.group.traverse((obj) => {
      const mesh = obj as unknown as {
        geometry?: { dispose?: () => void };
        material?: { map?: { dispose?: () => void }; dispose?: () => void } | Array<{ map?: { dispose?: () => void }; dispose?: () => void }>;
      };
      mesh.geometry?.dispose?.();
      if (Array.isArray(mesh.material)) {
        for (const m of mesh.material) {
          m?.map?.dispose?.();
          m?.dispose?.();
        }
      } else {
        mesh.material?.map?.dispose?.();
        mesh.material?.dispose?.();
      }
    });
  }

  private static createDimGrassTexture(): THREE.CanvasTexture {
    const size = 16;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const checker = (x + y) % 2 === 0;
        ctx.fillStyle = checker ? '#4a7d3a' : '#3d6a30';
        ctx.fillRect(x, y, 1, 1);
      }
    }
    const tex = new THREE.CanvasTexture(canvas);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    return tex;
  }

  private static createGrassTexture(): THREE.CanvasTexture {
    const size = 16;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const checker = (x + y) % 2 === 0;
        ctx.fillStyle = checker ? '#6fbf4a' : '#5aa83d';
        ctx.fillRect(x, y, 1, 1);
      }
    }
    const tex = new THREE.CanvasTexture(canvas);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(4, 1);
    return tex;
  }

  private resetCamera(): void {
    this.cameraFocus.copy(this.gridToWorld(4, 0));
    this.cameraGoal.copy(this.cameraFocus);
  }

  private gridToWorld(column: number, laneIndex: number): THREE.Vector3 {
    return new THREE.Vector3(column * TILE, 0.4, laneIndex * LANE_DEPTH);
  }

  private ensureLaneMesh(index: number, kind: CrossLaneType): void {
    if (this.laneMeshes.has(index)) return;

    const group = new THREE.Group();
    const width = CROSS_COLUMN_COUNT * TILE;
    const centerX = ((CROSS_COLUMN_COUNT - 1) * TILE) / 2;
    const z = index * LANE_DEPTH;

    const matFor = (color: number, map?: THREE.Texture) =>
      new THREE.MeshLambertMaterial(map ? { color, map } : { color });

    if (kind === 'grass') {
      const base = new THREE.Mesh(
        new THREE.BoxGeometry(width + 0.2, 0.22, LANE_DEPTH),
        matFor(0xffffff, this.grassTexture),
      );
      base.receiveShadow = true;
      base.position.set(centerX, -0.08, z);
      group.add(base);
      if (index > 1) {
        this.addLaneDecor(group, centerX, z, index);
      }
    } else if (kind === 'road') {
      const road = new THREE.Mesh(
        new THREE.BoxGeometry(width + 0.2, 0.22, LANE_DEPTH),
        matFor(COLORS.road),
      );
      road.receiveShadow = true;
      road.position.set(centerX, -0.08, z);
      group.add(road);
      for (let i = 0; i < 6; i++) {
        const dash = new THREE.Mesh(
          new THREE.BoxGeometry(0.4, 0.03, 0.1),
          new THREE.MeshBasicMaterial({ color: COLORS.roadMark }),
        );
        dash.position.set(centerX + i * 1.6 - 4, 0.03, z);
        group.add(dash);
      }
    } else if (kind === 'water') {
      const water = new THREE.Mesh(
        new THREE.BoxGeometry(width + 0.2, 0.2, LANE_DEPTH),
        matFor(COLORS.water),
      );
      water.position.set(centerX, -0.09, z);
      group.add(water);
      const ripple = new THREE.Mesh(
        new THREE.BoxGeometry(width, 0.04, LANE_DEPTH * 0.6),
        new THREE.MeshLambertMaterial({
          color: COLORS.waterDeep,
          transparent: true,
          opacity: 0.4,
        }),
      );
      ripple.position.set(centerX, 0.02, z);
      group.add(ripple);
    } else if (kind === 'rails') {
      const bed = new THREE.Mesh(
        new THREE.BoxGeometry(width + 0.2, 0.22, LANE_DEPTH),
        matFor(0x4a3f33),
      );
      bed.position.set(centerX, -0.08, z);
      group.add(bed);
      // Wooden ties: denser, alternating shade for that Minecraft plank vibe.
      const tieCount = 13;
      const tieSpacing = (width - 0.6) / (tieCount - 1);
      for (let t = 0; t < tieCount; t++) {
        const tie = new THREE.Mesh(
          new THREE.BoxGeometry(0.45, 0.08, LANE_DEPTH * 0.9),
          matFor(t % 2 === 0 ? COLORS.railTie : 0x5a4530),
        );
        tie.position.set(centerX - width / 2 + 0.3 + t * tieSpacing, 0.04, z);
        group.add(tie);
      }
      // Twin steel rails sit ON the ties, narrower gauge for pixel-y look.
      for (const rx of [-1.7, 1.7]) {
        const rail = new THREE.Mesh(
          new THREE.BoxGeometry(width + 1, 0.08, 0.1),
          matFor(COLORS.railMetal),
        );
        rail.position.set(centerX + rx, 0.12, z);
        group.add(rail);
      }
      // Gravel chips around the bed for texture.
      for (let g = 0; g < 6; g++) {
        const chip = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.06, 0.12), matFor(0x6a5a4a));
        const seed = (g * 37 + index * 13) % 100;
        chip.position.set(centerX + ((seed % 9) - 4) * 1.1, 0.04, z + (seed > 50 ? 0.32 : -0.32));
        group.add(chip);
      }
    }

    this.worldGroup.add(group);
    this.laneMeshes.set(index, group);
  }

  private addLaneDecor(group: THREE.Group, centerX: number, z: number, index: number): void {
    const rng = (seed: number) => {
      const x = Math.sin(seed * 12.9898 + index * 4.1414) * 43758.5453;
      return x - Math.floor(x);
    };
    if (rng(1) > 0.4) {
      const tree = this.createTree();
      tree.position.set(centerX + (rng(2) - 0.5) * 3, 0, z + (rng(3) - 0.5) * 0.25);
      group.add(tree);
    }
    if (rng(4) > 0.7) {
      const rock = new THREE.Mesh(
        new THREE.BoxGeometry(0.5, 0.28, 0.45),
        new THREE.MeshLambertMaterial({ color: COLORS.sandDark }),
      );
      rock.position.set(centerX + (rng(5) - 0.5) * 4, 0.14, z);
      group.add(rock);
    }
  }

  private buildWildernessScenery(): void {
    const centerX = ((CROSS_COLUMN_COUNT - 1) * TILE) / 2;
    const playHalfW = (CROSS_COLUMN_COUNT * TILE) / 2 + 1;

    const hash = (x: number, z: number) => {
      const v = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453;
      return v - Math.floor(v);
    };

    for (let gz = -90; gz <= 90; gz += 2.4) {
      for (const side of [-1, 1]) {
        for (let layer = 0; layer < 8; layer++) {
          const x = centerX + side * (playHalfW + 2 + layer * 1.8);
          const z = gz + hash(x, gz) * 1.2;
          const r = hash(x * 0.7, z * 1.3);

          if (r < 0.25) continue;

          if (r < 0.42) {
            const tree = r < 0.22 ? this.createPineTree() : this.createTree();
            tree.position.set(x + (hash(z, x) - 0.5) * 1.2, 0, z);
            tree.scale.setScalar(0.75 + hash(x, z) * 0.5);
            this.sceneryGroup.add(tree);
          } else if (r < 0.52) {
            this.sceneryGroup.add(this.createMountain(x, z, hash(x + z, z)));
          } else if (r < 0.68) {
            const size = 0.42 + hash(z, x) * 0.22;
            const bush = new THREE.Mesh(
              new THREE.BoxGeometry(size, size * 0.85, size),
              new THREE.MeshLambertMaterial({ color: COLORS.grassDark }),
            );
            bush.position.set(x, size * 0.42, z);
            this.sceneryGroup.add(bush);
          } else if (r < 0.82) {
            const rock = this.createRockCluster(hash(x, z));
            rock.position.set(x, 0, z);
            this.sceneryGroup.add(rock);
          } else {
            const cactus = this.createCactus();
            cactus.position.set(x, 0, z);
            this.sceneryGroup.add(cactus);
          }
        }
      }
    }

    for (let gz = -90; gz <= 90; gz += 8) {
      for (const side of [-1, 1]) {
        const hill = new THREE.Mesh(
          new THREE.BoxGeometry(6, 0.2 + hash(gz, side) * 0.3, 7),
          new THREE.MeshLambertMaterial({
            color: side < 0 ? 0x3d6a30 : 0x4a7d3a,
          }),
        );
        hill.position.set(centerX + side * (playHalfW + 8), -0.05, gz);
        this.sceneryGroup.add(hill);
      }
    }
  }

  private createMountain(x: number, z: number, scale: number): THREE.Group {
    const g = new THREE.Group();
    const h = 1.2 + scale * 2.2;
    const tiers = 4;
    for (let i = 0; i < tiers; i++) {
      const tier = new THREE.Mesh(
        new THREE.BoxGeometry(2.8 - i * 0.55, 0.55 + i * 0.15, 2.4 - i * 0.45),
        new THREE.MeshLambertMaterial({
          color: i < tiers - 1 ? 0x6b5a48 : COLORS.grassDark,
        }),
      );
      tier.position.set(0, 0.28 + i * 0.5, 0);
      g.add(tier);
    }
    const snow = new THREE.Mesh(
      new THREE.BoxGeometry(0.9, 0.25, 0.8),
      new THREE.MeshLambertMaterial({ color: 0xf5f5f5 }),
    );
    snow.position.set(0, h, 0);
    g.add(snow);
    g.position.set(x, 0, z);
    return g;
  }

  private createRockCluster(seed: number): THREE.Group {
    const g = new THREE.Group();
    const mat = new THREE.MeshLambertMaterial({ color: 0x8a7a6a });
    for (let i = 0; i < 3; i++) {
      const rock = new THREE.Mesh(
        new THREE.BoxGeometry(0.5 + seed * 0.4, 0.3 + i * 0.1, 0.45),
        mat,
      );
      rock.position.set(i * 0.35 - 0.35, 0.15, (i % 2) * 0.2);
      g.add(rock);
    }
    return g;
  }

  private createPineTree(): THREE.Group {
    const g = new THREE.Group();
    const trunk = new THREE.Mesh(
      new THREE.BoxGeometry(0.22, 0.5, 0.22),
      new THREE.MeshLambertMaterial({ color: COLORS.treeTrunk }),
    );
    trunk.position.y = 0.25;
    g.add(trunk);
    for (let i = 0; i < 3; i++) {
      const layer = new THREE.Mesh(
        new THREE.BoxGeometry(0.85 - i * 0.2, 0.4, 0.85 - i * 0.2),
        new THREE.MeshLambertMaterial({ color: i === 0 ? 0x2d6b3a : 0x3a8048 }),
      );
      layer.position.y = 0.55 + i * 0.36;
      g.add(layer);
    }
    return g;
  }

  private createCactus(): THREE.Group {
    const g = new THREE.Group();
    const mat = new THREE.MeshLambertMaterial({ color: 0x3d8b4a });
    const main = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.7, 0.28), mat);
    main.position.y = 0.35;
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.18, 0.18), mat);
    arm.position.set(0.22, 0.5, 0);
    const armTop = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.3, 0.18), mat);
    armTop.position.set(0.31, 0.65, 0);
    g.add(main, arm, armTop);
    return g;
  }

  private syncHazard(hazard: CrossHazardSnapshot): void {
    let mesh = this.hazardMeshes.get(hazard.id);
    if (!mesh) {
      if (hazard.kind === 'car') mesh = this.createCarMesh();
      else if (hazard.kind === 'train') mesh = this.createTrainMesh(hazard.width);
      else mesh = this.createLogMesh(hazard.width);
      this.hazardMeshes.set(hazard.id, mesh);
      this.worldGroup.add(mesh);
      // Snap to initial position so the first frame has no lerp artifact.
      mesh.position.set(hazard.x * TILE, 0.38, hazard.laneIndex * LANE_DEPTH);
      return;
    }
    // lerp smooths the discrete 300ms-tick hazard feed; snap on wrap. visual only.
    // Snap when the distance exceeds half the board width (hazard wrapped columns).
    const targetX = hazard.x * TILE;
    if (Math.abs(targetX - mesh.position.x) > (CROSS_COLUMN_COUNT * TILE) / 2) {
      mesh.position.x = targetX; // wrap: snap, don't lerp
    } else {
      mesh.position.x += (targetX - mesh.position.x) * LOG_RIDE_LERP; // smooth follow
    }
    mesh.position.z = hazard.laneIndex * LANE_DEPTH;
  }

  private syncPlayer(player: CrossPlayerState, onWater: boolean): void {
    const target = this.gridToWorld(player.column, player.laneIndex);
    target.y = onWater ? 0.44 : 0.4;
    const facing = player.facing ?? 'north';
    const facingGoal = crossFacingYaw(facing);
    const discreteCol = Math.round(player.column);
    let visual = this.playerVisuals.get(player.id);
    const isLocal = player.id === this.localPlayerId;

    if (!visual) {
      const group = this.createChickenMesh(isLocal, player.name);
      visual = {
        group,
        from: target.clone(),
        to: target.clone(),
        hopStart: performance.now(),
        facingYaw: facingGoal,
        facingGoal,
        lastLane: player.laneIndex,
        lastDiscreteCol: discreteCol,
        ridingLog: onWater,
        baseScale: isLocal ? 1.1 : 0.95,
      };
      group.position.copy(target);
      group.rotation.y = facingGoal;
      this.playerVisuals.set(player.id, visual);
      this.playersGroup.add(group);
    } else {
      const laneChanged = player.laneIndex !== visual.lastLane;
      const colHop = Math.abs(discreteCol - visual.lastDiscreteCol) >= 1;

      if (onWater && !laneChanged) {
        visual.to.copy(target);
        visual.ridingLog = true;
      } else if (laneChanged || colHop) {
        visual.from.copy(visual.group.position);
        visual.to.copy(target);
        visual.hopStart = performance.now();
        visual.lastLane = player.laneIndex;
        visual.lastDiscreteCol = discreteCol;
        visual.ridingLog = false;
      } else {
        visual.to.copy(target);
        visual.ridingLog = false;
      }
      visual.facingGoal = facingGoal;
    }

    visual.baseScale = isLocal ? 1.1 : 0.95;
    const label = visual.group.getObjectByName('nametag');
    if (label) label.visible = !isLocal;
  }

  private createCarMesh(): THREE.Group {
    const group = new THREE.Group();
    const paint = new THREE.MeshLambertMaterial({ color: COLORS.car });
    const glass = new THREE.MeshLambertMaterial({ color: COLORS.carWindow });
    const trim = new THREE.MeshLambertMaterial({ color: 0x4a3878 });
    const wheelMat = new THREE.MeshLambertMaterial({ color: 0x1a1a1a });

    const body = new THREE.Mesh(new THREE.BoxGeometry(1.75, 0.5, 1.05), paint);
    body.castShadow = true;
    const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.05, 0.38, 0.95), paint);
    cabin.position.set(-0.05, 0.28, 0);
    const roof = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.08, 0.9), trim);
    roof.position.set(-0.05, 0.5, 0);
    const windshield = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.32, 0.05), glass);
    windshield.position.set(-0.05, 0.32, 0.5);
    const rearWindow = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.28, 0.05), glass);
    rearWindow.position.set(-0.05, 0.32, -0.48);
    const bumperF = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.12, 0.12), trim);
    bumperF.position.set(0, 0.08, 0.58);
    const bumperR = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.12, 0.12), trim);
    bumperR.position.set(0, 0.08, -0.58);
    for (const [hx, hz] of [
      [-0.55, 0.42],
      [0.55, 0.42],
    ] as const) {
      const headlight = new THREE.Mesh(
        new THREE.BoxGeometry(0.18, 0.1, 0.08),
        new THREE.MeshLambertMaterial({ color: 0xfff3a0, emissive: 0x665500 }),
      );
      headlight.position.set(hx, 0.12, hz);
      group.add(headlight);
    }
    for (const [wx, wz] of [
      [-0.62, 0.38],
      [0.62, 0.38],
      [-0.62, -0.32],
      [0.62, -0.32],
    ] as const) {
      const wheel = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.26, 0.16), wheelMat);
      wheel.position.set(wx, -0.1, wz);
      group.add(wheel);
    }
    group.add(body, cabin, roof, windshield, rearWindow, bumperF, bumperR);
    return group;
  }

  private createTrainMesh(width: number): THREE.Group {
    const group = new THREE.Group();
    const scale = (width * TILE) / 10;
    const wheelMat = new THREE.MeshLambertMaterial({ color: 0x1a1a1a });
    const trim = new THREE.MeshLambertMaterial({ color: 0xd4af37 });

    // Locomotive at the LEFT end of the train.
    const locoX = -3.8 * scale;
    const locoBody = new THREE.Mesh(
      new THREE.BoxGeometry(2.0 * scale, 0.7, 0.95),
      new THREE.MeshLambertMaterial({ color: COLORS.trainEngine }),
    );
    locoBody.castShadow = true;
    locoBody.position.set(locoX, 0.35, 0);

    const locoStripe = new THREE.Mesh(new THREE.BoxGeometry(2.02 * scale, 0.1, 0.97), trim);
    locoStripe.position.set(locoX, 0.18, 0);

    const cabin = new THREE.Mesh(
      new THREE.BoxGeometry(0.7 * scale, 0.45, 0.85),
      new THREE.MeshLambertMaterial({ color: 0x5a1414 }),
    );
    cabin.position.set(locoX - 0.55 * scale, 0.82, 0);

    const cabinWindow = new THREE.Mesh(
      new THREE.BoxGeometry(0.5 * scale, 0.22, 0.06),
      new THREE.MeshLambertMaterial({
        color: COLORS.trainWindow,
        emissive: 0x554422,
      }),
    );
    cabinWindow.position.set(locoX - 0.55 * scale, 0.85, 0.46);

    const chimney = new THREE.Mesh(
      new THREE.BoxGeometry(0.3, 0.55, 0.3),
      new THREE.MeshLambertMaterial({ color: 0x222222 }),
    );
    chimney.position.set(locoX + 0.55 * scale, 0.98, 0);
    const chimneyCap = new THREE.Mesh(
      new THREE.BoxGeometry(0.4, 0.1, 0.4),
      new THREE.MeshLambertMaterial({ color: 0x111111 }),
    );
    chimneyCap.position.set(chimney.position.x, 1.3, 0);

    const headlight = new THREE.Mesh(
      new THREE.BoxGeometry(0.18, 0.18, 0.12),
      new THREE.MeshLambertMaterial({ color: 0xffeea0, emissive: 0x886600 }),
    );
    headlight.position.set(locoX + 1.0 * scale, 0.45, 0);

    group.add(locoBody, locoStripe, cabin, cabinWindow, chimney, chimneyCap, headlight);

    // Trailing cars (boxcars).
    for (let c = 0; c < 3; c++) {
      const carGroup = new THREE.Group();
      const carColor = c === 0 ? 0x6a4524 : c === 1 ? COLORS.trainCar : 0x2e7d32;
      const body = new THREE.Mesh(
        new THREE.BoxGeometry(1.6 * scale, 0.6, 0.9),
        new THREE.MeshLambertMaterial({ color: carColor }),
      );
      body.castShadow = true;
      body.position.y = 0.34;
      const roof = new THREE.Mesh(
        new THREE.BoxGeometry(1.65 * scale, 0.08, 0.95),
        new THREE.MeshLambertMaterial({ color: 0x111111 }),
      );
      roof.position.y = 0.68;
      // Two square windows per side for that boxcar look.
      for (const wx of [-0.4 * scale, 0.4 * scale]) {
        const win = new THREE.Mesh(
          new THREE.BoxGeometry(0.32, 0.22, 0.06),
          new THREE.MeshLambertMaterial({ color: 0x1a1a1a }),
        );
        win.position.set(wx, 0.42, 0.46);
        carGroup.add(win);
      }
      // Coupler stub between cars.
      const coupler = new THREE.Mesh(
        new THREE.BoxGeometry(0.18, 0.1, 0.1),
        new THREE.MeshLambertMaterial({ color: 0x333333 }),
      );
      coupler.position.set(0.85 * scale, 0.18, 0);
      carGroup.add(body, roof, coupler);
      carGroup.position.x = (-1.4 + c * 1.85) * scale;
      group.add(carGroup);
    }

    // Cubical pixel wheels (no cylinders) along the whole train length.
    const wheelXs: number[] = [];
    for (let c = 0; c < 3; c++) {
      const base = (-1.4 + c * 1.85) * scale;
      wheelXs.push(base - 0.45 * scale, base + 0.45 * scale);
    }
    wheelXs.push(locoX - 0.7 * scale, locoX + 0.7 * scale);
    for (const wx of wheelXs) {
      for (const wz of [-0.35, 0.35]) {
        const wheel = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.22, 0.18), wheelMat);
        wheel.position.set(wx, 0.05, wz);
        group.add(wheel);
      }
    }

    return group;
  }

  private createLogMesh(width: number): THREE.Group {
    const group = new THREE.Group();
    const w = width * TILE * 0.9;
    const bark = new THREE.MeshLambertMaterial({ color: COLORS.log });
    const end = new THREE.MeshLambertMaterial({ color: 0x5a3d1e });
    const core = new THREE.Mesh(new THREE.BoxGeometry(w, 0.36, 0.74), bark);
    core.castShadow = true;
    const capL = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.38, 0.76), end);
    capL.position.x = -w / 2 - 0.04;
    const capR = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.38, 0.76), end);
    capR.position.x = w / 2 + 0.04;
    for (let i = -2; i <= 2; i++) {
      const ring = new THREE.Mesh(
        new THREE.BoxGeometry(0.06, 0.38, 0.78),
        new THREE.MeshLambertMaterial({ color: 0x4a3018 }),
      );
      ring.position.x = i * (w / 5);
      group.add(ring);
    }
    group.add(core, capL, capR);
    return group;
  }

  private createChickenMesh(isLocal: boolean, name: string): THREE.Group {
    const group = new THREE.Group();
    const bodyMat = new THREE.MeshLambertMaterial({ color: COLORS.chicken });
    const wingMat = new THREE.MeshLambertMaterial({ color: COLORS.wing });
    const eyeMat = new THREE.MeshLambertMaterial({ color: COLORS.eye });

    const body = new THREE.Mesh(new THREE.BoxGeometry(0.58, 0.52, 0.55), bodyMat);
    body.castShadow = true;
    body.position.y = 0.26;

    const head = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.38, 0.4), bodyMat);
    head.position.set(0, 0.58, 0.12);

    const comb = new THREE.Mesh(
      new THREE.BoxGeometry(0.2, 0.14, 0.1),
      new THREE.MeshLambertMaterial({ color: COLORS.comb }),
    );
    comb.position.set(0, 0.82, 0.08);

    const beak = new THREE.Mesh(
      new THREE.BoxGeometry(0.12, 0.1, 0.2),
      new THREE.MeshLambertMaterial({ color: COLORS.beak }),
    );
    beak.position.set(0, 0.52, 0.38);

    const wattle = new THREE.Mesh(
      new THREE.BoxGeometry(0.08, 0.1, 0.06),
      new THREE.MeshLambertMaterial({ color: COLORS.comb }),
    );
    wattle.position.set(0, 0.44, 0.32);

    for (const [ex, ey] of [
      [-0.12, 0.58],
      [0.12, 0.58],
    ]) {
      const eye = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.08, 0.04), eyeMat);
      eye.position.set(ex, ey, 0.32);
      group.add(eye);
    }

    for (const wx of [-0.34, 0.34]) {
      const wing = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.22, 0.38), wingMat);
      wing.position.set(wx, 0.3, 0);
      group.add(wing);
    }

    for (const fx of [-0.18, 0.18]) {
      const foot = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.06, 0.14), eyeMat);
      foot.position.set(fx, 0.03, 0.1);
      group.add(foot);
    }

    group.add(body, head, comb, beak, wattle);

    const arrow = new THREE.Mesh(
      new THREE.ConeGeometry(0.22, 0.45, 4),
      new THREE.MeshBasicMaterial({ color: COLORS.arrow }),
    );
    arrow.name = 'heading-arrow';
    arrow.rotation.x = Math.PI / 2;
    arrow.position.set(0, 0.05, 0.72);
    group.add(arrow);

    if (isLocal) {
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(0.42, 0.52, 24),
        new THREE.MeshBasicMaterial({
          color: COLORS.arrow,
          transparent: true,
          opacity: 0.45,
        }),
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.02;
      group.add(ring);
    } else {
      const canvas = document.createElement('canvas');
      canvas.width = 128;
      canvas.height = 32;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(0, 0, 128, 32);
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 14px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(name.slice(0, 10), 64, 21);
      const sprite = new THREE.Sprite(
        new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas), depthTest: false }),
      );
      sprite.name = 'nametag';
      sprite.position.y = 1.15;
      sprite.scale.set(1.8, 0.45, 1);
      group.add(sprite);
    }

    return group;
  }

  private createTree(): THREE.Group {
    const g = new THREE.Group();
    const trunk = new THREE.Mesh(
      new THREE.BoxGeometry(0.22, 0.45, 0.22),
      new THREE.MeshLambertMaterial({ color: COLORS.treeTrunk }),
    );
    trunk.position.y = 0.22;
    const leafBase = new THREE.Mesh(
      new THREE.BoxGeometry(0.7, 0.42, 0.7),
      new THREE.MeshLambertMaterial({ color: COLORS.treeLeaf }),
    );
    leafBase.position.y = 0.66;
    const leafTop = new THREE.Mesh(
      new THREE.BoxGeometry(0.42, 0.28, 0.42),
      new THREE.MeshLambertMaterial({ color: 0x6cc956 }),
    );
    leafTop.position.y = 1.0;
    g.add(trunk, leafBase, leafTop);
    return g;
  }
}
