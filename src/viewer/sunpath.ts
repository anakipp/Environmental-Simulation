/**
 * 3D sun-path diagram (cf. Ladybug "LB SunPath"): compass, altitude rings,
 * monthly day arcs (21st of each month), hourly analemmas, and the current sun.
 */
import * as THREE from 'three';
import { Location, sunPosition, directionFromAltAz, MONTH_NAMES } from '../core/solar';

function textSprite(text: string, color: string, px = 48): THREE.Sprite {
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d')!;
  ctx.font = `600 ${px}px system-ui, sans-serif`;
  const w = Math.ceil(ctx.measureText(text).width) + 16;
  c.width = w;
  c.height = px + 16;
  ctx.font = `600 ${px}px system-ui, sans-serif`;
  ctx.fillStyle = color;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 8, c.height / 2);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  s.userData.aspect = c.width / c.height;
  s.renderOrder = 10;
  return s;
}

function polyline(points: THREE.Vector3[], material: THREE.LineBasicMaterial): THREE.Line {
  return new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), material);
}

export interface SunPathOptions {
  location: Location;
  northAngle: number;
  center: THREE.Vector3;
  radius: number;
  dark: boolean;
}

export function buildSunPath(o: SunPathOptions): THREE.Group {
  const g = new THREE.Group();
  g.name = 'SunPath';
  const R = o.radius;
  const ink = o.dark ? '#c9ced6' : '#3d4450';
  const faint = new THREE.LineBasicMaterial({ color: o.dark ? 0x59606b : 0xa7adb6, transparent: true, opacity: 0.8 });
  const strong = new THREE.LineBasicMaterial({ color: o.dark ? 0x9aa1ab : 0x5b6370 });
  const arcMat = new THREE.LineBasicMaterial({ color: 0xe8a33d });
  const anaMat = new THREE.LineBasicMaterial({ color: o.dark ? 0x6d8fc9 : 0x4b6ba9, transparent: true, opacity: 0.8 });

  const at = (alt: number, az: number, r = R) => {
    const d = directionFromAltAz(alt, az, o.northAngle);
    return new THREE.Vector3(o.center.x + d[0] * r, o.center.y + d[1] * r, o.center.z + d[2] * r);
  };

  // compass rings + ticks
  for (const [r, mat] of [[R, strong], [R * 1.08, faint]] as const) {
    const pts: THREE.Vector3[] = [];
    for (let a = 0; a <= 360; a += 3) pts.push(at(0, a, r));
    g.add(polyline(pts, mat));
  }
  for (let a = 0; a < 360; a += 15) {
    const len = a % 90 === 0 ? 1.16 : a % 45 === 0 ? 1.12 : 1.08;
    g.add(polyline([at(0, a, R), at(0, a, R * len)], a % 90 === 0 ? strong : faint));
  }
  const labels: [string, number][] = [['N', 0], ['E', 90], ['S', 180], ['W', 270]];
  for (const [t, a] of labels) {
    const s = textSprite(t, ink);
    const h = R * 0.07;
    s.scale.set(h * s.userData.aspect, h, 1);
    s.position.copy(at(0, a, R * 1.25));
    g.add(s);
  }
  // altitude rings
  for (const alt of [30, 60]) {
    const pts: THREE.Vector3[] = [];
    for (let a = 0; a <= 360; a += 4) pts.push(at(alt, a));
    g.add(polyline(pts, faint));
  }

  // monthly arcs on the 21st (Dec–Jun share paths with Jun–Dec)
  for (let m = 1; m <= 12; m++) {
    const pts: THREE.Vector3[] = [];
    for (let h = 0; h <= 24; h += 0.1) {
      const s = sunPosition(o.location, m, 21, h, o.northAngle);
      if (s.altitude >= 0) pts.push(at(s.altitude, s.azimuth));
      else if (pts.length) break;
    }
    if (pts.length > 1) g.add(polyline(pts, arcMat));
  }
  // hourly analemmas
  for (let h = 0; h < 24; h++) {
    let seg: THREE.Vector3[] = [];
    const flush = () => {
      if (seg.length > 1) g.add(polyline(seg, anaMat));
      seg = [];
    };
    for (let doy = 0; doy <= 365; doy += 4) {
      const date = new Date(Date.UTC(2017, 0, 1 + (doy % 365)));
      const s = sunPosition(o.location, date.getUTCMonth() + 1, date.getUTCDate(), h, o.northAngle);
      if (s.altitude >= 0) seg.push(at(s.altitude, s.azimuth));
      else flush();
    }
    flush();
  }

  const sun = new THREE.Mesh(
    new THREE.SphereGeometry(R * 0.035, 24, 16),
    new THREE.MeshBasicMaterial({ color: 0xffc23d }),
  );
  sun.name = 'Sun';
  g.add(sun);
  const ray = polyline([o.center.clone(), o.center.clone()], new THREE.LineBasicMaterial({ color: 0xffb02e }));
  ray.name = 'SunRay';
  g.add(ray);
  g.userData.monthNames = MONTH_NAMES;
  return g;
}

export function placeSun(g: THREE.Group, center: THREE.Vector3, radius: number, vector: [number, number, number], visible: boolean) {
  const sun = g.getObjectByName('Sun') as THREE.Mesh | undefined;
  const ray = g.getObjectByName('SunRay') as THREE.Line | undefined;
  if (!sun || !ray) return;
  const p = new THREE.Vector3(...vector).multiplyScalar(radius).add(center);
  sun.position.copy(p);
  sun.visible = visible;
  ray.visible = visible;
  (ray.geometry as THREE.BufferGeometry).setFromPoints([center, p]);
}
