/**
 * Model editing: imported-mesh baking, generated parts (boxes, parametric rooms,
 * shading devices), transforms, duplicate/delete, undo/redo and a registry of
 * numeric parameters that the edit panel and the optimizer both drive.
 */
import * as THREE from 'three';
import { Viewer, Part } from '../viewer/viewer';
import { Role, worldTriangles, collectMeshes, meshLabel, guessRole } from '../viewer/loaders';
import {
  BoxParams, RoomParams, ShadeParams, ShadeType, Facade, FACADES,
  boxTriangles, roomGeometry, findPanes, flipPane, shadeTriangles, Pane,
} from './generators';
import type { GenInfo, RoomPiece } from './types';

export interface ParamDef {
  key: string;
  label: string;
  /** owner shown in pickers, e.g. part or room name */
  owner: string;
  unit: string;
  step: number;
  /** suggested search range for optimization */
  min: number;
  max: number;
  get(): number;
  set(v: number): void;
}

interface PartSnap {
  part: Part;
  name: string;
  role: Role;
  visible: boolean;
  geometry: THREE.BufferGeometry;
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  scale: THREE.Vector3;
  gen?: GenInfo;
}

const ROOM_PIECES: { piece: RoomPiece; role: Role; label: string }[] = [
  { piece: 'floor', role: 'floor', label: 'Floor' },
  { piece: 'roof', role: 'context', label: 'Roof' },
  { piece: 'walls', role: 'context', label: 'Walls' },
  { piece: 'glazing', role: 'glazing', label: 'Glazing' },
];

export const DEFAULT_ROOM: RoomParams = {
  width: 8, depth: 6, height: 3, sill: 0.9, windowHeight: 1.6, wwr: { s: 0.4, e: 0, n: 0, w: 0 },
};

function geometryFrom(tris: Float32Array): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(tris, 3));
  g.computeVertexNormals();
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

const r1 = (v: number) => Math.round(v * 1000) / 1000;
const DEG = 180 / Math.PI;

export class ModelEditor {
  private undoStack: PartSnap[][] = [];
  private redoStack: PartSnap[][] = [];
  private nextRoomGroup = 1;
  private raycaster = new THREE.Raycaster();
  /** called after any model change (geometry, transform, role, add/remove) */
  onChange: (() => void) | null = null;

  constructor(readonly viewer: Viewer) {}

  // ------------------------------------------------------------ import
  /**
   * Bake an imported object into parts: every mesh's world transform is applied
   * to a cloned geometry, which is recentred on its base so the part rotates about
   * its own footprint.
   */
  importObject(root: THREE.Object3D, roles?: Record<string, Role>): Part[] {
    root.updateMatrixWorld(true);
    const meshes = collectMeshes(root);
    if (!meshes.length) throw new Error('No mesh geometry found in the file.');
    const added: Part[] = [];
    meshes.forEach((m, i) => {
      const name = meshLabel(m, i);
      const mat = Array.isArray(m.material) ? m.material[0] : m.material;
      const g = (m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone()).applyMatrix4(m.matrixWorld);
      g.deleteAttribute('uv');
      g.computeBoundingBox();
      const b = g.boundingBox!;
      const pivot = new THREE.Vector3((b.min.x + b.max.x) / 2, b.min.y, (b.min.z + b.max.z) / 2);
      g.translate(-pivot.x, -pivot.y, -pivot.z);
      g.computeVertexNormals();
      g.computeBoundingSphere();
      const mesh = new THREE.Mesh(g);
      mesh.name = name;
      mesh.position.copy(pivot);
      mesh.updateMatrix();
      added.push(
        this.viewer.addPart({
          name, mesh, role: roles?.[name] ?? guessRole(name, mat?.name ?? ''), visible: true,
          triangles: g.attributes.position.count / 3, home: mesh.matrix.clone(),
        }),
      );
    });
    this.changed(true);
    return added;
  }

  // ------------------------------------------------------------ generated parts
  addBox(params: BoxParams, at: THREE.Vector3, name = 'Box', role: Role = 'context'): Part {
    const mesh = new THREE.Mesh(geometryFrom(boxTriangles(params)));
    mesh.position.copy(at);
    const part = this.viewer.addPart({
      name: this.uniqueName(name), mesh, role, visible: true, triangles: 12,
      gen: { kind: 'box', params: { ...params } },
    });
    this.changed(true);
    return part;
  }

  addRoom(params: RoomParams, at: THREE.Vector3, rotationDeg = 0, name = 'Room'): Part[] {
    const group = this.nextRoomGroup++;
    const shared: RoomParams = { ...params, wwr: { ...params.wwr } };
    const base = this.uniqueName(name);
    const geo = roomGeometry(shared);
    const parts = ROOM_PIECES.map(({ piece, role, label }) => {
      const mesh = new THREE.Mesh(geometryFrom(geo[piece]));
      mesh.position.copy(at);
      mesh.rotation.y = rotationDeg / DEG;
      return this.viewer.addPart({
        name: `${base} ${label}`, mesh, role, visible: true, triangles: geo[piece].length / 9,
        gen: { kind: 'room', group, piece, params: shared },
      });
    });
    this.changed(true);
    return parts;
  }

  /** Add shading devices to every vertical pane of a glazing part. */
  addShade(source: Part, params: ShadeParams): Part {
    const mesh = new THREE.Mesh(new THREE.BufferGeometry());
    const label = params.type === 'overhang' ? 'Overhang' : params.type === 'fins' ? 'Fins' : 'Louvers';
    const part = this.viewer.addPart({
      name: this.uniqueName(`${label} · ${source.name}`), mesh, role: 'context', visible: true, triangles: 0,
      gen: { kind: 'shade', sourceId: source.id, params: { ...params } },
    });
    this.regenerate(part);
    if (!part.triangles) {
      this.viewer.removePart(part);
      throw new Error('No vertical window panes found on this glazing mesh.');
    }
    this.changed(true);
    return part;
  }

  roomParts(group: number): Part[] {
    return this.viewer.parts.filter((p) => p.gen?.kind === 'room' && p.gen.group === group);
  }

  /** Parts that move together with `p` (a whole room, or just the part). */
  linkedParts(p: Part): Part[] {
    return p.gen?.kind === 'room' ? this.roomParts(p.gen.group) : [p];
  }

  /** Rebuild a generated part's geometry from its parameters. */
  regenerate(p: Part) {
    const gen = p.gen;
    if (!gen) return;
    let tris: Float32Array;
    if (gen.kind === 'box') tris = boxTriangles(gen.params);
    else if (gen.kind === 'room') tris = roomGeometry(gen.params)[gen.piece];
    else {
      const src = this.viewer.parts.find((q) => q.id === gen.sourceId);
      tris = src ? shadeTriangles(this.orientedPanes(src), gen.params) : new Float32Array(0);
    }
    // never mutate in place: undo snapshots keep the old geometry
    p.mesh.geometry = geometryFrom(tris);
    p.triangles = tris.length / 9;
  }

  /** Regenerate shades that hang off any of `sources` (after they moved or changed). */
  private regenerateDependents(sources: Part[]) {
    const ids = new Set(sources.map((s) => s.id));
    for (const p of this.viewer.parts) if (p.gen?.kind === 'shade' && ids.has(p.gen.sourceId)) this.regenerate(p);
  }

  private regenerateRoom(group: number) {
    const parts = this.roomParts(group);
    const g = parts[0]?.gen;
    if (!g || g.kind !== 'room') return;
    const geo = roomGeometry(g.params);
    for (const p of parts) {
      if (p.gen?.kind !== 'room') continue;
      p.mesh.geometry = geometryFrom(geo[p.gen.piece]);
      p.triangles = geo[p.gen.piece].length / 9;
    }
    this.regenerateDependents(parts);
  }

  /** Window panes of a glazing part, each oriented to face outdoors. */
  private orientedPanes(src: Part): Pane[] {
    const panes = findPanes(worldTriangles(src.mesh));
    const blockers = this.viewer.parts
      .filter((p) => p !== src && p.role !== 'glazing' && p.role !== 'ignore' && p.gen?.kind !== 'shade')
      .map((p) => p.mesh);
    for (const m of blockers) m.updateMatrixWorld();
    const dist = (o: THREE.Vector3, d: THREE.Vector3) => {
      this.raycaster.set(o, d);
      this.raycaster.far = 200;
      return this.raycaster.intersectObjects(blockers, false)[0]?.distance ?? Infinity;
    };
    return panes.map((p) => {
      const c = new THREE.Vector3(...p.center);
      const n = new THREE.Vector3(...p.normal);
      const front = dist(c.clone().addScaledVector(n, 0.02), n);
      const back = dist(c.clone().addScaledVector(n, -0.02), n.clone().negate());
      return front < back ? flipPane(p) : p;
    });
  }

  // ------------------------------------------------------------ editing
  duplicate(p: Part): Part[] {
    this.record();
    const offset = new THREE.Vector3(2, 0, 2);
    let out: Part[];
    if (p.gen?.kind === 'room') {
      const src = this.roomParts(p.gen.group)[0].mesh;
      out = this.addRoom(p.gen.params, src.position.clone().add(offset), src.rotation.y * DEG, p.name.replace(/ (Floor|Roof|Walls|Glazing)$/, ''));
    } else if (p.gen?.kind === 'shade') {
      const src = this.viewer.parts.find((q) => q.id === (p.gen as { sourceId: number }).sourceId);
      if (!src) return [];
      out = [this.addShade(src, p.gen.params)];
    } else {
      const mesh = new THREE.Mesh(p.mesh.geometry);
      mesh.position.copy(p.mesh.position).add(offset);
      mesh.quaternion.copy(p.mesh.quaternion);
      mesh.scale.copy(p.mesh.scale);
      out = [
        this.viewer.addPart({
          name: this.uniqueName(p.name), mesh, role: p.role, visible: true, triangles: p.triangles,
          gen: p.gen ? (JSON.parse(JSON.stringify(p.gen)) as GenInfo) : undefined,
        }),
      ];
    }
    this.changed(true);
    return out;
  }

  remove(p: Part) {
    this.record();
    const doomed = new Set(this.linkedParts(p));
    // shading devices of removed glazing go too
    for (const q of this.viewer.parts) if (q.gen?.kind === 'shade' && [...doomed].some((d) => d.id === (q.gen as { sourceId: number }).sourceId)) doomed.add(q);
    for (const d of doomed) this.viewer.removePart(d);
    this.changed(true);
  }

  resetTransform(p: Part) {
    if (!p.home) return;
    this.record();
    p.home.decompose(p.mesh.position, p.mesh.quaternion, p.mesh.scale);
    this.afterTransform(p);
  }

  setRole(p: Part, role: Role) {
    this.record();
    p.role = role;
    this.viewer.styleMesh(p);
    this.changed(true);
  }

  rename(p: Part, name: string) {
    this.record();
    p.name = name.trim() || p.name;
    this.changed(false);
  }

  setShadeType(p: Part, type: ShadeType) {
    if (p.gen?.kind !== 'shade') return;
    this.record();
    p.gen.params.type = type;
    this.regenerate(p);
    this.changed(true);
  }

  /** Call after a part's mesh transform changed (gizmo or numeric input). */
  afterTransform(p: Part, final = true) {
    if (p.gen?.kind === 'room') {
      for (const q of this.roomParts(p.gen.group)) {
        if (q === p) continue;
        q.mesh.position.copy(p.mesh.position);
        q.mesh.quaternion.copy(p.mesh.quaternion);
        q.mesh.scale.copy(p.mesh.scale);
      }
    }
    if (final) {
      this.regenerateDependents(this.linkedParts(p));
      this.changed(true);
    } else this.viewer.invalidate();
  }

  private uniqueName(base: string): string {
    const names = new Set(this.viewer.parts.map((p) => p.name));
    if (!names.has(base)) return base;
    for (let i = 2; ; i++) if (!names.has(`${base} ${i}`)) return `${base} ${i}`;
  }

  private changed(bounds: boolean) {
    if (bounds) this.viewer.updateBounds();
    this.viewer.invalidate();
    this.onChange?.();
  }

  // ------------------------------------------------------------ undo / redo
  private snapshot(): PartSnap[] {
    // room groups share one params object; clone it once per group so the link survives
    const roomClones = new Map<number, RoomParams>();
    return this.viewer.parts.map((p) => {
      let gen: GenInfo | undefined;
      if (p.gen?.kind === 'room') {
        const g = p.gen;
        if (!roomClones.has(g.group)) roomClones.set(g.group, { ...g.params, wwr: { ...g.params.wwr } });
        gen = { ...g, params: roomClones.get(g.group)! };
      } else if (p.gen) gen = JSON.parse(JSON.stringify(p.gen)) as GenInfo;
      return {
        part: p, name: p.name, role: p.role, visible: p.visible, geometry: p.mesh.geometry,
        position: p.mesh.position.clone(), quaternion: p.mesh.quaternion.clone(), scale: p.mesh.scale.clone(), gen,
      };
    });
  }

  private restore(snap: PartSnap[]) {
    const roomShared = new Map<number, RoomParams>();
    for (const s of snap) {
      const p = s.part;
      p.name = s.name;
      p.role = s.role;
      p.visible = s.visible;
      p.mesh.geometry = s.geometry;
      p.mesh.position.copy(s.position);
      p.mesh.quaternion.copy(s.quaternion);
      p.mesh.scale.copy(s.scale);
      p.triangles = (s.geometry.attributes.position?.count ?? 0) / 3;
      if (s.gen?.kind === 'room') {
        if (!roomShared.has(s.gen.group)) roomShared.set(s.gen.group, { ...s.gen.params, wwr: { ...s.gen.params.wwr } });
        p.gen = { ...s.gen, params: roomShared.get(s.gen.group)! };
      } else p.gen = s.gen ? (JSON.parse(JSON.stringify(s.gen)) as GenInfo) : undefined;
    }
    this.viewer.setParts(snap.map((s) => s.part));
    this.changed(true);
  }

  /** Record, then run a change; drop the record again if the change throws. */
  recordAnd<T>(fn: () => T): T {
    this.record();
    try {
      return fn();
    } catch (e) {
      this.undoStack.pop();
      throw e;
    }
  }

  /** Save the current state before a change. */
  record() {
    this.undoStack.push(this.snapshot());
    if (this.undoStack.length > 60) this.undoStack.shift();
    this.redoStack = [];
  }

  canUndo() { return this.undoStack.length > 0; }
  canRedo() { return this.redoStack.length > 0; }

  undo() {
    const s = this.undoStack.pop();
    if (!s) return;
    this.redoStack.push(this.snapshot());
    this.restore(s);
  }

  redo() {
    const s = this.redoStack.pop();
    if (!s) return;
    this.undoStack.push(this.snapshot());
    this.restore(s);
  }

  clearHistory() {
    this.undoStack = [];
    this.redoStack = [];
  }

  // ------------------------------------------------------------ parameters
  /** Numeric parameters of one part (for a room: the whole room). */
  paramsFor(p: Part): ParamDef[] {
    const out: ParamDef[] = [];
    const gen = p.gen;
    const owner = gen?.kind === 'room' ? p.name.replace(/ (Floor|Roof|Walls|Glazing)$/, '') : p.name;
    const keyBase = gen?.kind === 'room' ? `room${gen.group}` : `part${p.id}`;
    const mesh = p.mesh;
    const transform = (axis: 'x' | 'y' | 'z', label: string, lo: number, hi: number) =>
      out.push({
        key: `${keyBase}.pos.${axis}`, label, owner, unit: 'm', step: 0.1,
        min: r1(mesh.position[axis] + lo), max: r1(mesh.position[axis] + hi),
        get: () => mesh.position[axis],
        set: (v) => { mesh.position[axis] = v; this.afterTransform(p); },
      });

    if (gen?.kind === 'shade') {
      const sp = gen.params;
      const num = (k: 'depth' | 'count' | 'angle' | 'offset' | 'extension', label: string, unit: string, step: number, min: number, max: number) =>
        out.push({
          key: `${keyBase}.${k}`, label, owner, unit, step, min, max,
          get: () => sp[k],
          set: (v) => { sp[k] = k === 'count' ? Math.max(1, Math.round(v)) : v; this.regenerate(p); this.changed(false); },
        });
      num('depth', 'Depth', 'm', 0.05, 0.1, 2);
      if (sp.type !== 'overhang') num('count', sp.type === 'fins' ? 'Fins per window' : 'Slats per window', '', 1, 1, 12);
      num('angle', sp.type === 'fins' ? 'Rotation' : 'Downward tilt', '°', 5, sp.type === 'fins' ? -60 : 0, 60);
      num('offset', sp.type === 'overhang' ? 'Height above head' : 'Gap from glass', 'm', 0.05, 0, 0.6);
      if (sp.type === 'overhang') num('extension', 'Side extension', 'm', 0.05, 0, 1);
      return out;
    }

    transform('x', 'Position X (east)', -10, 10);
    if (gen?.kind !== 'room') transform('y', 'Position Y (up)', -3, 3);
    transform('z', 'Position Z (south)', -10, 10);
    out.push({
      key: `${keyBase}.rot`, label: 'Rotation', owner, unit: '°', step: 5, min: -90, max: 90,
      get: () => ((((mesh.rotation.y * DEG) % 360) + 540) % 360) - 180,
      set: (v) => { mesh.rotation.y = v / DEG; this.afterTransform(p); },
    });

    if (gen?.kind === 'box') {
      const bp = gen.params;
      for (const [k, label] of [['width', 'Width (X)'], ['depth', 'Depth (Z)'], ['height', 'Height']] as const) {
        out.push({
          key: `${keyBase}.${k}`, label, owner, unit: 'm', step: 0.1, min: r1(Math.max(0.5, bp[k] * 0.5)), max: r1(bp[k] * 1.5),
          get: () => bp[k],
          set: (v) => { bp[k] = Math.max(0.1, v); this.regenerate(p); this.changed(true); },
        });
      }
    } else if (gen?.kind === 'room') {
      const rp = gen.params;
      const group = gen.group;
      const dim = (k: 'width' | 'depth' | 'height' | 'sill' | 'windowHeight', label: string, min: number, max: number) =>
        out.push({
          key: `${keyBase}.${k}`, label, owner, unit: 'm', step: 0.05, min, max,
          get: () => rp[k],
          set: (v) => { rp[k] = Math.max(k === 'sill' ? 0 : 0.3, v); this.regenerateRoom(group); this.changed(true); },
        });
      dim('width', 'Width (X)', r1(rp.width * 0.6), r1(rp.width * 1.4));
      dim('depth', 'Depth (Z)', r1(rp.depth * 0.6), r1(rp.depth * 1.4));
      dim('height', 'Ceiling height', 2.4, 4.5);
      dim('sill', 'Sill height', 0, 1.2);
      dim('windowHeight', 'Window height', 0.6, 2.8);
      for (const f of FACADES) {
        out.push({
          key: `${keyBase}.wwr.${f.key}`, label: `Window ratio ${f.label}`, owner, unit: '', step: 0.05, min: 0, max: 0.8,
          get: () => rp.wwr[f.key as Facade],
          set: (v) => { rp.wwr[f.key as Facade] = Math.min(0.9, Math.max(0, v)); this.regenerateRoom(group); this.changed(false); },
        });
      }
    } else {
      for (const axis of ['x', 'y', 'z'] as const) {
        out.push({
          key: `${keyBase}.scale.${axis}`, label: `Scale ${axis.toUpperCase()}`, owner, unit: '×', step: 0.05, min: 0.5, max: 1.5,
          get: () => mesh.scale[axis],
          set: (v) => { mesh.scale[axis] = Math.max(0.01, v); this.afterTransform(p); },
        });
      }
    }
    return out;
  }

  /** All model parameters, one entry per part (rooms listed once). */
  allParams(): ParamDef[] {
    const seenRooms = new Set<number>();
    const out: ParamDef[] = [];
    for (const p of this.viewer.parts) {
      if (p.role === 'ignore') continue;
      if (p.gen?.kind === 'room') {
        if (seenRooms.has(p.gen.group)) continue;
        seenRooms.add(p.gen.group);
      }
      out.push(...this.paramsFor(p));
    }
    return out;
  }

  /** Run `fn` while suppressing change notifications and bounds updates (batch edits). */
  quietly<T>(fn: () => T): T {
    const cb = this.onChange;
    const ub = this.viewer.updateBounds;
    this.onChange = null;
    this.viewer.updateBounds = () => {};
    try {
      return fn();
    } finally {
      this.onChange = cb;
      this.viewer.updateBounds = ub;
    }
  }

  /** Re-sync bounds and listeners after a quiet batch. */
  refresh() {
    this.changed(true);
  }

  achievedWwr(p: Part): Record<Facade, number> | null {
    return p.gen?.kind === 'room' ? roomGeometry(p.gen.params).achieved : null;
  }
}
