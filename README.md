# Environmental Simulation Studio

A browser app for **environmental analysis of architecture and interiors**, modelled on the
workflow of [Ladybug](https://www.ladybug.tools/ladybug.html) and
[Honeybee](https://www.ladybug.tools/honeybee.html) for Grasshopper: upload a model, assign
roles to its geometry, set location / weather / sky parameters, run a ray-traced study, and
explore or export the results.

Everything runs locally in the browser (Web Worker + BVH ray tracing) — no server and no
Rhino licence needed.

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

The app opens with a **sample site** (a glazed studio between neighbouring buildings) and the
San Francisco TMY3 weather file, so every study can be run immediately.

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
src/sim/       engine.ts (BVH ray tracing) · worker.ts · client.ts (worker + main-thread fallback)
src/viewer/    viewer.ts (three.js scene, shadows, section cut, results) · sunpath.ts
               loaders.ts (OBJ/GLB/STL/PLY, roles) · sampleModel.ts
src/ui/        charts.ts (histogram, heat-map, monthly, wind rose) · climate.ts
public/weather sample EPW files (U.S. DOE / NREL TMY3)
test/          vitest unit tests
```

## Limitations

- Geometry is treated as single-sided surfaces; glazing is counted once per pane even if
  modelled with two faces less than 1 mm apart.
- Interior reflections use one reflectance for all opaque surfaces.
- Rhino `.3dm` is not read directly — export OBJ or glTF from Rhino.
- Weather years are 8760 h (leap days are dropped).
