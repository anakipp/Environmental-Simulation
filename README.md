# Environmental Simulation Studio

A browser app for **environmental analysis of architecture and interiors**, modelled on the
workflow of [Ladybug](https://www.ladybug.tools/ladybug.html) and
[Honeybee](https://www.ladybug.tools/honeybee.html) for Grasshopper: upload a model, assign
roles to its geometry, set location / weather / sky parameters, run a ray-traced study, and
explore or export the results.

Everything runs locally in the browser (Web Worker + BVH ray tracing) — no server and no
Rhino licence needed.

**Live app:** https://anakipp.github.io/Environmental-Simulation/

## Quick start

```bash
npm install
npm run dev        # http://localhost:5173
```

```bash
npm test           # unit tests for solar, sky, comfort, weather, grids and the ray engine
npm run build      # static site in dist/ (deploy anywhere, e.g. GitHub Pages)
npm run build:single   # one self-contained HTML file in dist-single/
```

### Deploying to GitHub Pages

`.github/workflows/deploy-pages.yml` tests, builds and publishes `dist/` on every push to
`main` (or manually via *Actions → Deploy to GitHub Pages → Run workflow*). One-time setup:
in the repository's **Settings → Pages**, set **Source** to **GitHub Actions**.

The app opens with a **sample site** (a parametric glazed studio between three editable
neighbouring blocks) and the San Francisco TMY3 weather file, so every study and the optimizer
can be run immediately.

## Workflow

1. **Model** — drop an `.obj`, `.glb/.gltf`, `.stl` or `.ply` file. Choose its units and up-axis
   (Rhino/SketchUp/Revit exports are Z-up). Each mesh/layer gets a role, guessed from its name
   and editable in the list (click a mesh in 3D to find it):

   | Role | Ladybug/Honeybee equivalent | Used as |
   |---|---|---|
   | Analysis surface | `_geometry` of LB Incident Radiation / Direct Sun Hours | sensor grid on its faces, also opaque |
   | Floor → work plane | HB Room floor grid | horizontal sensor grid at work-plane height |
   | Glazing | HB Aperture | transmits light with transmittance τ |
   | Context (opaque) | `context_` | blocks sun and sky |
   | Ignore | — | excluded |

   *Tip from Rhino:* `Export Selected` → OBJ (meters, "Export objects as meshes", one object per
   layer) or glTF, and name layers e.g. `Glass`, `Floor`, `Ground` for automatic roles.

   **Editing the model.** Select a mesh (click it in 3D or in the list) to open its edit panel:
   - **Move / Rotate / Scale** with the on-screen handles (`W` / `E` / `R`, snapping optional)
     or by typing values; *Reset position* returns an imported mesh to where it was imported.
   - **Duplicate** (`Ctrl+D`), **Delete**, rename, change role; **Undo / Redo** (`Ctrl+Z` /
     `Ctrl+Shift+Z`) for every edit.
   - **+ Box**: a massing block (context building, shading block) with width / depth / height.
   - **+ Room**: a parametric room like HB Room + *HB Apertures by Ratio*: width, depth, ceiling
     height, sill height, window height and a window-to-wall ratio per facade. Floor (work plane),
     roof, walls and glazing are generated together and move together.
   - **+ Shading** (select a glazing mesh first): an **overhang**, **fins** or **louvers** on every
     vertical window pane, like *HB Louver Shades* / *HB Extruded Border Shades*: depth, count,
     tilt or rotation, offset. Devices follow their window when it moves or changes size.
   - **Export model** saves the edited model as GLB.

   Results computed before an edit are flagged as out of date with a *Run again* button.
   Vertex editing and booleans are not supported: do those in Rhino and re-import. Window sizes
   of imported models can't be changed (the wall opening would stay); use a generated room for
   window-ratio studies.

2. **Location & weather** — pick a bundled EPW (San Francisco, Chicago), upload any EPW from
   [climate.onebuilding.org](https://climate.onebuilding.org), or enter latitude / longitude /
   time zone for a synthetic clear-sky year. Set the **north angle** (counter-clockwise, as in
   Ladybug).

3. **Sun path & shadows** — 3D sun-path diagram (monthly arcs, hourly analemmas, compass) with
   live shadows for any date/time; animate a day.

4. **Analysis** — choose a study, the sensor grid (surfaces or work plane), grid size, offset,
   analysis period, sky density and materials, then **Run**.

5. **Results** — coloured result mesh with legend (Ladybug palette and others, min/max, stepped
   or continuous), hover read-out per sensor, area-weighted mean, % of area above a threshold,
   histogram, run history, and export to **CSV / JSON** (positions, normals, areas, values),
   **GLB** (coloured mesh + model) and **PNG**.

6. **Climate & comfort** — hourly heat-map of any EPW field, monthly chart, wind rose,
   ASHRAE-55 adaptive comfort, and a PMV/PPD calculator.

7. **Optimize** — a Galapagos-style search (see below).

## Optimization (Galapagos-style)

Open **Optimize** in the top bar. Like Galapagos in Grasshopper, you connect *genes* (sliders)
to a *fitness* and let a solver breed better designs. The goal is set per project:

1. **Genes:** any numeric parameter, each with min / max / step:
   - **site:** north angle (site rotation) and glazing transmittance;
   - **any part:** position and rotation, plus scale for imported meshes;
   - **boxes:** width, depth and height;
   - **rooms:** dimensions, sill and window height, and window ratio per facade;
   - **shading:** depth, count, tilt and offset.
2. **Objectives:** set up a study in *4 · Analysis* (type, grid, period, sky…) and press
   *Add current study as objective*. For each objective choose a measure (area-weighted mean,
   % of area ≥ threshold, min, max, total value × m²) and a goal: **maximize**, **minimize**, or a
   constraint **keep at least / at most** a target. Several objectives are combined by weight,
   e.g. *maximize daylight-factor area ≥ 2 %* **and** *keep summer radiation on the façade at most
   X kWh/m²*.
3. **Solver:**
   - **Evolutionary (genetic):** population, generations, % of best designs kept, mutation
     rate, and stop after N generations without improvement;
   - **Simulated annealing:** number of designs and cooling rate.

   **Draft quality** runs the search on a coarser grid, without interior reflections, then
   re-checks the best 5 designs at full quality.

The panel shows best and mean fitness per generation and a ranked table with every objective's
value and gene values. **Apply** loads a design into the model (undoable). The model is restored
to its starting state after each run.

**Fitness** is the weighted sum of objectives relative to the starting design: for a single
*maximize* goal, 1.0 means as good as now and 1.2 means 20 % better. Each unit of constraint
violation (relative to the target) subtracts 10 × weight. Designs are evaluated in parallel Web
Workers (one per CPU core, up to 6), and no design is ever evaluated twice. On the sample site a
daylight-factor objective took about 0.6 s per design at draft quality on 4 cores (two objectives).

Like Galapagos, this is a single-objective search: multiple goals are folded into one number by
their weights. A Pareto front (Octopus / Wallacei style) is not implemented.

## Studies and methods

| Study | Reference component | Method |
|---|---|---|
| Direct sun hours | LB Direct Sun Hours | hourly sun vectors in the analysis period (NOAA solar position); counts hours a sensor sees the sun in front of it |
| Incident radiation | LB Incident Radiation + Cumulative Sky Matrix | Tregenza (145) or Reinhart (577) sky patches from the EPW: DNI and Hay-Davies circumsolar diffuse binned to the sun's patch, remaining diffuse isotropic, optional uniform ground (ρ·GHI/π); kWh/m² |
| Sky view / exposure | LB Sky View | % of sky patches visible (uniform = exposure, cosine-weighted = view factor) |
| Daylight factor | HB Daylight Factor | CIE standard overcast sky, glazing transmittance per pane crossed, external ground reflection, optional interior reflections |
| Point-in-time illuminance | HB Point-in-Time Grid | CIE clear sky + sun or CIE overcast, scaled by the EPW's diffuse-horizontal and direct-normal illuminance at the chosen hour (or manual lux values) |

**Interior reflections** (daylight studies): one diffuse bounce is ray traced with
cosine-weighted hemisphere samples from each sensor (the illuminance at each hit point is
computed against the sky); "multi-bounce" adds an enclosure-based estimate
`1 / (1 − ρ·f_enclosed)`. This is a fast approximation of Radiance's ambient bounces, good for
design comparison — use Honeybee-Radiance for certification-grade results.

**Coordinate system**: three.js Y-up, metres, −Z = north before the north-angle rotation.
A Rhino point `(x, y, z)` appears as `(x, z, −y)` in exports.

## Project layout

```
src/core/      solar.ts (NOAA sun, periods) · sky.ts (Tregenza/Reinhart, cumulative & CIE skies)
               weather.ts (EPW parser, synthetic clear sky) · comfort.ts (PMV, adaptive)
               grid.ts (surface & work-plane grids) · colors.ts (legend palettes)
               optimize.ts (evolutionary solver, simulated annealing)
src/model/     generators.ts (box, room + apertures by ratio, panes, shading) · editor.ts (edits,
               undo/redo, parameter registry) · types.ts
src/sim/       engine.ts (BVH ray tracing) · worker.ts · client.ts (worker + main-thread fallback)
               pool.ts (parallel workers)
src/study.ts   study settings → sensor grid + ray-tracing job (shared by Run and the optimizer)
src/viewer/    viewer.ts (three.js scene, shadows, section cut, transform gizmo, results)
               sunpath.ts · loaders.ts (OBJ/GLB/STL/PLY, roles) · sampleModel.ts
src/ui/        charts.ts (histogram, heat-map, monthly, wind rose) · climate.ts
               modelPanel.ts (parts list, edit panel) · optimizer.ts (optimizer panel)
public/weather sample EPW files (U.S. DOE / NREL TMY3)
test/          vitest unit tests
```

## Limitations

- Geometry is treated as single-sided surfaces; glazing is counted once per pane even if
  modelled with two faces less than 1 mm apart.
- Interior reflections use one reflectance for all opaque surfaces.
- Rhino `.3dm` is not read directly — export OBJ or glTF from Rhino.
- Weather years are 8760 h (leap days are dropped).
