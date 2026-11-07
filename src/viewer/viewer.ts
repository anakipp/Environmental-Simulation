import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { buildSunPath, placeSun } from './sunpath';
import { Location } from '../core/solar';
import { Role } from './loaders';

export interface Part {
  id: number;
  name: string;
  mesh: THREE.Mesh;
  role: Role;
  visible: boolean;
  triangles: number;
}

const ROLE_COLORS: Record<Role, number> = {
  context: 0xd9d6cf,
  analysis: 0xc8cfc0,
  floor: 0xcfc5b5,
  glazing: 0x8ec5e6,
  ignore: 0x999999,
};

export class Viewer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  readonly modelRoot = new THREE.Group();
  readonly resultRoot = new THREE.Group();
  readonly helperRoot = new THREE.Group();
  readonly sunLight = new THREE.DirectionalLight(0xffffff, 2.2);
  readonly hemi = new THREE.HemisphereLight(0xffffff, 0x8a8577, 1.1);
  private shadowGround: THREE.Mesh;
  private sunPath: THREE.Group | null = null;
  private resultMesh: THREE.Mesh | null = null;
  private raycaster = new THREE.Raycaster();
  private needsRender = true;
  private sunVector: [number, number, number] = [0.3, 0.8, 0.4];
  private sunUp = true;
  dark = false;
  showSunPath = true;
  shadowsOn = true;
  onPick: ((hit: { kind: 'result'; face: number; point: THREE.Vector3; clientX: number; clientY: number } | null) => void) | null = null;
  onSelectPart: ((p: Part) => void) | null = null;
  parts: Part[] = [];

  constructor(private container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.localClippingEnabled = true;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.05, 5000);
    this.camera.position.set(30, 25, 40);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.addEventListener('change', () => (this.needsRender = true));

    this.scene.add(this.hemi, this.sunLight, this.sunLight.target, this.modelRoot, this.resultRoot, this.helperRoot);
    this.sunLight.castShadow = true;
    this.sunLight.shadow.mapSize.set(2048, 2048);
    this.sunLight.shadow.bias = -0.0004;
    this.sunLight.shadow.normalBias = 0.02;

    this.shadowGround = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShadowMaterial({ opacity: 0.22 }));
    this.shadowGround.rotation.x = -Math.PI / 2;
    this.shadowGround.receiveShadow = true;
    this.helperRoot.add(this.shadowGround);

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    this.bindPointer();
    const loop = () => {
      requestAnimationFrame(loop);
      if (this.controls.update() || this.needsRender) {
        this.needsRender = false;
        this.renderer.render(this.scene, this.camera);
      }
    };
    loop();
  }

  setTheme(dark: boolean) {
    this.dark = dark;
    this.scene.background = new THREE.Color(dark ? 0x16191e : 0xf3f2ee);
    this.hemi.intensity = dark ? 0.9 : 1.1;
    this.invalidate();
  }

  invalidate() {
    this.needsRender = true;
  }

  private resize() {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.invalidate();
  }

  private bindPointer() {
    const el = this.renderer.domElement;
    let down: { x: number; y: number } | null = null;
    el.addEventListener('pointerdown', (e) => (down = { x: e.clientX, y: e.clientY }));
    el.addEventListener('pointerup', (e) => {
      if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 4) this.pick(e, true);
      down = null;
    });
    el.addEventListener('pointermove', (e) => {
      if (e.buttons === 0) this.pick(e, false);
    });
    el.addEventListener('pointerleave', () => this.onPick?.(null));
  }

  private pick(e: PointerEvent, click: boolean) {
    const r = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    if (this.resultMesh?.visible) {
      const hit = this.raycaster.intersectObject(this.resultMesh, false)[0];
      if (hit && hit.faceIndex != null) {
        this.onPick?.({ kind: 'result', face: hit.faceIndex, point: hit.point, clientX: e.clientX, clientY: e.clientY });
        return;
      }
    }
    this.onPick?.(null);
    if (click) {
      const meshes = this.parts.filter((p) => p.visible).map((p) => p.mesh);
      const hit = this.raycaster.intersectObjects(meshes, false)[0];
      const part = hit && this.parts.find((p) => p.mesh === hit.object);
      if (part) this.onSelectPart?.(part);
    }
  }

  // ---------- model ----------
  addModel(root: THREE.Object3D, parts: Omit<Part, 'id'>[]) {
    this.modelRoot.add(root);
    for (const p of parts) {
      const part: Part = { ...p, id: this.parts.length ? Math.max(...this.parts.map((q) => q.id)) + 1 : 1 };
      this.parts.push(part);
      this.styleMesh(part);
    }
    this.updateBounds();
  }

  clearModel() {
    this.modelRoot.clear();
    this.parts = [];
    this.clearResult();
    this.updateBounds();
  }

  // ---------- section cut ----------
  private clipPlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), 1e6);
  sectionOn = false;

  setSection(on: boolean, height: number) {
    this.sectionOn = on;
    this.clipPlane.constant = height;
    for (const p of this.parts) {
      const m = p.mesh.material as THREE.Material;
      m.clippingPlanes = on ? [this.clipPlane] : null;
      m.needsUpdate = true;
    }
    this.invalidate();
  }

  styleMesh(p: Part) {
    const transparent = p.role === 'glazing';
    p.mesh.material = new THREE.MeshStandardMaterial({
      clippingPlanes: this.sectionOn ? [this.clipPlane] : null,
      clipShadows: true,
      color: ROLE_COLORS[p.role],
      roughness: transparent ? 0.1 : 0.85,
      metalness: 0,
      transparent,
      opacity: transparent ? 0.35 : 1,
      side: THREE.DoubleSide,
      depthWrite: !transparent,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    });
    p.mesh.castShadow = !transparent && p.role !== 'ignore';
    p.mesh.receiveShadow = true;
    p.mesh.visible = p.visible && p.role !== 'ignore';
    this.invalidate();
  }

  highlight(part: Part | null) {
    for (const p of this.parts) {
      const m = p.mesh.material as THREE.MeshStandardMaterial;
      m.emissive?.setHex(p === part ? 0x3a6fd8 : 0x000000);
      m.emissiveIntensity = p === part ? 0.45 : 0;
    }
    this.invalidate();
  }

  bounds(): THREE.Box3 {
    const b = new THREE.Box3();
    for (const p of this.parts) if (p.role !== 'ignore') b.expandByObject(p.mesh);
    if (b.isEmpty()) b.set(new THREE.Vector3(-10, 0, -10), new THREE.Vector3(10, 5, 10));
    return b;
  }

  private center = new THREE.Vector3();
  private radius = 20;

  updateBounds() {
    const b = this.bounds();
    const size = b.getSize(new THREE.Vector3());
    this.center.set((b.min.x + b.max.x) / 2, b.min.y, (b.min.z + b.max.z) / 2);
    this.radius = Math.max(size.x, size.z, size.y * 1.5) * 0.75 + 1;
    this.shadowGround.scale.set(this.radius * 6, this.radius * 6, 1);
    this.shadowGround.position.set(this.center.x, b.min.y - 0.03, this.center.z);
    const cam = this.sunLight.shadow.camera;
    const r = this.radius * 1.6;
    cam.left = -r;
    cam.right = r;
    cam.top = r;
    cam.bottom = -r;
    cam.near = 0.1;
    cam.far = r * 6;
    cam.updateProjectionMatrix();
    this.camera.near = Math.max(0.01, this.radius / 500);
    this.camera.far = this.radius * 60;
    this.camera.updateProjectionMatrix();
    this.applySun();
    this.rebuildSunPathGeometry();
  }

  fit() {
    this.fitBox(this.bounds(), this.showSunPath ? 1.35 : 1);
  }

  fitResult() {
    if (!this.resultMesh) return this.fit();
    this.resultMesh.geometry.computeBoundingBox();
    this.fitBox(this.resultMesh.geometry.boundingBox!.clone(), 1);
  }

  private fitBox(b: THREE.Box3, extra: number) {
    const c = b.getCenter(new THREE.Vector3());
    const size = b.getSize(new THREE.Vector3());
    const r = Math.max(size.x, size.z, size.y * 1.5, 1) * 0.75 * extra;
    const fov = (this.camera.fov * Math.PI) / 180;
    const fit = r / Math.sin(fov / 2) / Math.min(1, this.camera.aspect);
    const d = fit * 1.05;
    this.controls.target.copy(c);
    this.camera.position.set(c.x + d * 0.55, c.y + d * 0.6, c.z + d * 0.6);
    this.controls.update();
    this.invalidate();
  }

  // ---------- sun ----------
  private sunPathParams: { location: Location; northAngle: number } | null = null;

  setSunPathParams(location: Location, northAngle: number) {
    this.sunPathParams = { location, northAngle };
    this.rebuildSunPathGeometry();
  }

  rebuildSunPathGeometry() {
    if (this.sunPath) {
      this.helperRoot.remove(this.sunPath);
      this.sunPath.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose();
      });
      this.sunPath = null;
    }
    if (!this.sunPathParams) return;
    this.sunPath = buildSunPath({ ...this.sunPathParams, center: this.center, radius: this.radius * 1.35, dark: this.dark });
    this.sunPath.visible = this.showSunPath;
    this.helperRoot.add(this.sunPath);
    this.applySun();
  }

  setSun(vector: [number, number, number], up: boolean) {
    this.sunVector = vector;
    this.sunUp = up;
    this.applySun();
  }

  private applySun() {
    const d = this.radius * 3;
    const v = new THREE.Vector3(...this.sunVector);
    this.sunLight.position.copy(this.center).addScaledVector(v, d);
    this.sunLight.target.position.copy(this.center);
    this.sunLight.intensity = this.sunUp ? 2.2 : 0;
    this.sunLight.castShadow = this.shadowsOn && this.sunUp;
    this.shadowGround.visible = this.shadowsOn;
    if (this.sunPath) {
      this.sunPath.visible = this.showSunPath;
      placeSun(this.sunPath, this.center, this.radius * 1.35, this.sunVector, this.sunUp);
    }
    this.invalidate();
  }

  setShadows(on: boolean) {
    this.shadowsOn = on;
    this.applySun();
  }

  setSunPathVisible(on: boolean) {
    this.showSunPath = on;
    this.applySun();
  }

  // ---------- results ----------
  setResult(triangles: Float32Array, colors: Float32Array, lift: number) {
    this.clearResult();
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(triangles, 3));
    g.computeVertexNormals();
    // lift the display mesh off the surface along its normals to avoid z-fighting
    const pos = g.attributes.position as THREE.BufferAttribute;
    const nor = g.attributes.normal as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      pos.setXYZ(i, pos.getX(i) + nor.getX(i) * lift, pos.getY(i) + nor.getY(i) * lift, pos.getZ(i) + nor.getZ(i) * lift);
    }
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const m = new THREE.Mesh(
      g,
      new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
    );
    m.name = 'AnalysisResult';
    this.resultMesh = m;
    this.resultRoot.add(m);
    this.invalidate();
  }

  updateResultColors(colors: Float32Array) {
    if (!this.resultMesh) return;
    const attr = this.resultMesh.geometry.getAttribute('color') as THREE.BufferAttribute;
    (attr.array as Float32Array).set(colors);
    attr.needsUpdate = true;
    this.invalidate();
  }

  setResultVisible(v: boolean) {
    if (this.resultMesh) this.resultMesh.visible = v;
    this.invalidate();
  }

  clearResult() {
    if (this.resultMesh) {
      this.resultRoot.remove(this.resultMesh);
      this.resultMesh.geometry.dispose();
      this.resultMesh = null;
    }
    this.invalidate();
  }

  screenshot(): string {
    this.renderer.render(this.scene, this.camera);
    return this.renderer.domElement.toDataURL('image/png');
  }

  async exportGLB(includeModel: boolean): Promise<ArrayBuffer> {
    const root = new THREE.Group();
    if (this.resultMesh) root.add(this.resultMesh.clone());
    if (includeModel) for (const p of this.parts) if (p.mesh.visible) root.add(p.mesh.clone());
    const out = await new GLTFExporter().parseAsync(root, { binary: true });
    return out as ArrayBuffer;
  }
}
