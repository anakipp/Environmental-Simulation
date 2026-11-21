/**
 * Model panel: parts list with roles, the edit panel for the selected part,
 * add buttons (box, room, shading), gizmo modes and keyboard shortcuts.
 */
import * as THREE from 'three';
import { Part } from '../viewer/viewer';
import { ROLE_LABELS, Role } from '../viewer/loaders';
import { ModelEditor, DEFAULT_ROOM, ParamDef } from '../model/editor';
import { DEFAULT_SHADE, ShadeType, FACADES } from '../model/generators';

const ROLE_SWATCH: Record<Role, string> = {
  context: '#d9d6cf', analysis: '#9fb38f', floor: '#c7a77b', glazing: '#6fb3df', ignore: 'transparent',
};

type GizmoMode = 'none' | 'translate' | 'rotate' | 'scale';

export function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

const $ = (id: string) => document.getElementById(id)!;

export class ModelPanel {
  selected: Part | null = null;
  private gizmoMode: GizmoMode = 'none';
  private panelSig = '';
  private defs: ParamDef[] = [];

  constructor(private editor: ModelEditor, private toast: (m: string, err?: boolean) => void) {
    const viewer = editor.viewer;
    viewer.onSelectPart = (p) => this.select(p === this.selected ? null : p);
    viewer.onGizmo = (phase) => {
      const p = this.selected;
      if (!p) return;
      if (phase === 'start') editor.record();
      else if (phase === 'change') {
        editor.afterTransform(p, false);
        this.syncValues();
      } else editor.afterTransform(p, true);
    };
    $('btnAddBox').onclick = () => {
      const t = viewer.controls.target;
      const p = editor.recordAnd(() => editor.addBox({ width: 6, depth: 6, height: 9 }, new THREE.Vector3(t.x, 0, t.z), 'Context box'));
      this.select(p);
      this.setGizmo('translate');
    };
    $('btnAddRoom').onclick = () => {
      const t = viewer.controls.target;
      const parts = editor.recordAnd(() => editor.addRoom(DEFAULT_ROOM, new THREE.Vector3(t.x, 0, t.z)));
      this.select(parts[0]);
    };
    $('btnAddShade').onclick = () => {
      const src = this.selected;
      if (!src || src.role !== 'glazing') {
        this.toast('Select a glazing mesh first (click a window, or pick it in the list).', true);
        return;
      }
      try {
        const part = editor.recordAnd(() => editor.addShade(src, DEFAULT_SHADE));
        this.select(part);
      } catch (e) {
        this.toast((e as Error).message, true);
      }
    };
    $('btnUndo').onclick = () => this.undo();
    $('btnRedo').onclick = () => this.redo();
    const snap = $('chkSnap') as HTMLInputElement;
    snap.onchange = () => viewer.setGizmoSnap(snap.checked);
    viewer.setGizmoSnap(true);
    window.addEventListener('keydown', (e) => this.onKey(e));
    this.refresh();
  }

  private onKey(e: KeyboardEvent) {
    if (document.body.classList.contains('optimizing')) return;
    const t = e.target as HTMLElement;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) this.redo();
      else this.undo();
    } else if (mod && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      this.redo();
    } else if (mod && e.key.toLowerCase() === 'd' && this.selected) {
      e.preventDefault();
      this.duplicate();
    } else if (!mod && this.selected) {
      const k = e.key.toLowerCase();
      if (k === 'w') this.setGizmo('translate');
      else if (k === 'e') this.setGizmo('rotate');
      else if (k === 'r' && this.canScale(this.selected)) this.setGizmo('scale');
      else if (k === 'escape') this.select(null);
      else if (k === 'delete' || k === 'backspace') {
        e.preventDefault();
        this.remove();
      }
    }
  }

  private canMove(p: Part) { return p.gen?.kind !== 'shade'; }
  private canScale(p: Part) { return !p.gen; }

  undo() {
    if (!this.editor.canUndo()) return this.toast('Nothing to undo.');
    this.editor.undo();
    if (this.selected && !this.editor.viewer.parts.includes(this.selected)) this.select(null);
    else this.reattach();
  }

  redo() {
    if (!this.editor.canRedo()) return this.toast('Nothing to redo.');
    this.editor.redo();
    if (this.selected && !this.editor.viewer.parts.includes(this.selected)) this.select(null);
    else this.reattach();
  }

  select(p: Part | null) {
    this.selected = p;
    this.editor.viewer.highlight(p);
    if (!p || !this.canMove(p)) this.gizmoMode = 'none';
    if (p && this.gizmoMode === 'scale' && !this.canScale(p)) this.gizmoMode = 'translate';
    this.reattach();
    this.refresh();
    if (p) {
      const idx = this.editor.viewer.parts.indexOf(p);
      ($('partList').children[idx] as HTMLElement | undefined)?.scrollIntoView({ block: 'nearest' });
    }
  }

  private setGizmo(mode: GizmoMode) {
    if (!this.selected || !this.canMove(this.selected)) return;
    if (mode === 'scale' && !this.canScale(this.selected)) return;
    this.gizmoMode = this.gizmoMode === mode ? 'none' : mode;
    this.reattach();
    this.panelSig = '';
    this.refresh();
  }

  private reattach() {
    const v = this.editor.viewer;
    if (this.selected && this.gizmoMode !== 'none') v.attachGizmo(this.selected.mesh, this.gizmoMode);
    else v.attachGizmo(null);
    v.highlight(this.selected);
  }

  private duplicate() {
    if (!this.selected) return;
    const out = this.editor.duplicate(this.selected);
    if (out[0]) this.select(out[0]);
  }

  private remove() {
    if (!this.selected) return;
    this.editor.remove(this.selected);
    this.select(null);
  }

  /** Re-render the list, and the edit panel if its structure changed (else just values). */
  refresh() {
    this.renderList();
    const p = this.selected && this.editor.viewer.parts.includes(this.selected) ? this.selected : null;
    if (!p) {
      this.selected = null;
      $('editPanel').hidden = true;
      this.panelSig = '';
    } else {
      this.defs = this.editor.paramsFor(p);
      const sig = `${p.id}|${p.name}|${p.role}|${p.gen?.kind === 'shade' ? p.gen.params.type : ''}|${this.defs.map((d) => d.key).join(',')}|${this.gizmoMode}`;
      if (sig !== this.panelSig) {
        this.panelSig = sig;
        this.renderPanel(p);
      } else this.syncValues();
    }
    ($('btnUndo') as HTMLButtonElement).disabled = !this.editor.canUndo();
    ($('btnRedo') as HTMLButtonElement).disabled = !this.editor.canRedo();
    ($('btnAddShade') as HTMLButtonElement).disabled = !(p && p.role === 'glazing');
  }

  private renderList() {
    const list = $('partList');
    list.innerHTML = '';
    for (const p of this.editor.viewer.parts) {
      const row = document.createElement('div');
      row.className = 'part' + (p === this.selected ? ' sel' : '');
      const vis = document.createElement('input');
      vis.type = 'checkbox';
      vis.checked = p.visible;
      vis.title = 'Show / hide';
      vis.setAttribute('aria-label', `Show ${p.name}`);
      vis.onchange = () => {
        p.visible = vis.checked;
        this.editor.viewer.styleMesh(p);
        this.editor.viewer.highlight(this.selected);
      };
      const sw = document.createElement('span');
      sw.className = 'swatch';
      sw.style.background = ROLE_SWATCH[p.role];
      const name = document.createElement('span');
      name.className = 'name';
      const kind = p.gen ? `<small class="kind">${p.gen.kind}</small> ` : '';
      name.innerHTML = `${kind}${escapeHtml(p.name)} <small>${p.triangles.toLocaleString()} tris</small>`;
      name.title = p.name;
      name.onclick = () => this.select(p === this.selected ? null : p);
      const sel = document.createElement('select');
      sel.setAttribute('aria-label', `Role of ${p.name}`);
      for (const [k, label] of Object.entries(ROLE_LABELS)) sel.add(new Option(label, k, false, k === p.role));
      sel.onchange = () => this.editor.setRole(p, sel.value as Role);
      row.append(vis, sw, name, sel);
      list.appendChild(row);
    }
  }

  private renderPanel(p: Part) {
    const el = $('editPanel');
    el.hidden = false;
    const kindLabel = p.gen?.kind === 'room' ? 'Parametric room' : p.gen?.kind === 'box' ? 'Box' : p.gen?.kind === 'shade' ? 'Shading device' : 'Imported mesh';
    const modeBtn = (m: GizmoMode, label: string, key: string, title: string) =>
      `<button class="btn ghost small${this.gizmoMode === m ? ' on' : ''}" data-mode="${m}" title="${title} (${key})" aria-pressed="${this.gizmoMode === m}">${label}</button>`;
    const fields = this.defs
      .map((d) => `<label>${escapeHtml(d.label)}${d.unit ? ` (${d.unit})` : ''}<input type="number" step="${d.step}" data-key="${d.key}" /></label>`)
      .join('');
    const shadeType = p.gen?.kind === 'shade'
      ? `<label>Device<select id="edShadeType">${(['overhang', 'fins', 'louvers'] as ShadeType[]).map((t) => `<option value="${t}"${p.gen?.kind === 'shade' && p.gen.params.type === t ? ' selected' : ''}>${t[0].toUpperCase() + t.slice(1)}</option>`).join('')}</select></label>`
      : '';
    const ww = this.editor.achievedWwr(p);
    const wwLine = ww ? `<p class="hint" id="edWwr">Achieved window ratio: ${FACADES.map((f) => `${f.key.toUpperCase()} ${(ww[f.key] * 100).toFixed(0)}%`).join(' · ')}</p>` : '';
    const note = p.gen?.kind === 'shade'
      ? '<p class="hint">Follows its window: move or change the glazing and the device updates.</p>'
      : p.gen?.kind === 'room'
        ? '<p class="hint">Floor, roof, walls and glazing move and update together.</p>'
        : '';
    el.innerHTML = `
      <div class="edit-head">
        <input type="text" id="edName" aria-label="Name" value="${escapeHtml(p.name)}" />
        <span class="tag">${kindLabel}</span>
      </div>
      ${this.canMove(p) ? `<div class="mode-row" role="group" aria-label="Transform tool">
        ${modeBtn('translate', 'Move', 'W', 'Drag arrows in 3D')}
        ${modeBtn('rotate', 'Rotate', 'E', 'Rotate about the vertical axis')}
        ${this.canScale(p) ? modeBtn('scale', 'Scale', 'R', 'Scale along axes') : ''}
      </div>` : ''}
      ${note}
      ${shadeType}
      <div class="param-grid">${fields}</div>
      ${wwLine}
      <div class="row wrap">
        <button class="btn ghost small" id="edDup" title="Ctrl+D">Duplicate</button>
        <button class="btn ghost small" id="edDel" title="Delete">Delete</button>
        ${p.home ? '<button class="btn ghost small" id="edReset">Reset position</button>' : ''}
      </div>`;
    el.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((b) => (b.onclick = () => this.setGizmo(b.dataset.mode as GizmoMode)));
    el.querySelectorAll<HTMLInputElement>('input[data-key]').forEach((inp) => {
      inp.onchange = () => {
        const d = this.defs.find((x) => x.key === inp.dataset.key);
        const v = parseFloat(inp.value);
        if (!d || !Number.isFinite(v)) return this.syncValues();
        this.editor.record();
        d.set(v);
      };
    });
    const nameInput = el.querySelector<HTMLInputElement>('#edName')!;
    nameInput.onchange = () => this.editor.rename(p, nameInput.value);
    el.querySelector<HTMLSelectElement>('#edShadeType')?.addEventListener('change', (e) => this.editor.setShadeType(p, (e.target as HTMLSelectElement).value as ShadeType));
    el.querySelector<HTMLButtonElement>('#edDup')!.onclick = () => this.duplicate();
    el.querySelector<HTMLButtonElement>('#edDel')!.onclick = () => this.remove();
    const reset = el.querySelector<HTMLButtonElement>('#edReset');
    if (reset) reset.onclick = () => this.editor.resetTransform(p);
    this.syncValues();
  }

  /** Update input values from the model without rebuilding the panel. */
  private syncValues() {
    const el = $('editPanel');
    el.querySelectorAll<HTMLInputElement>('input[data-key]').forEach((inp) => {
      if (document.activeElement === inp) return;
      const d = this.defs.find((x) => x.key === inp.dataset.key);
      if (d) inp.value = String(Math.round(d.get() * 1000) / 1000);
    });
    const p = this.selected;
    const ww = p && this.editor.achievedWwr(p);
    const line = el.querySelector('#edWwr');
    if (ww && line) line.textContent = `Achieved window ratio: ${FACADES.map((f) => `${f.key.toUpperCase()} ${(ww[f.key] * 100).toFixed(0)}%`).join(' · ')}`;
  }
}
