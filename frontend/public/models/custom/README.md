# Your own satellite models

Drop `.glb` files here (glTF binary; Draco-compressed files are fine) and register each one in
`../manifest.json`, **above** the NASA entries so it takes priority:

```json
{ "match": "^CARTOSAT-3$", "file": "custom/cartosat-3.glb", "title": "Cartosat-3", "exact": true, "credit": "Model author / source" }
```

- `match` is a case-insensitive regular expression tested against the satellite's catalog name as
  shown in the Fleet list (e.g. `^RISAT-2BR\d`, `^EOS-0[1-9]`, `^CARTOSAT`).
- `exact: false` labels the model "representative" (same family / bus rather than this spacecraft).
- `credit` is shown on the globe and in the 3D model viewer.
- `hide` (optional) drops stray parts by node-name prefix, e.g. `"hide": ["Ground", "Camera"]`.

Models are re-centred and scaled automatically, so any unit or origin works. Reload the dashboard
after editing the manifest; if a file fails to load, the satellite falls back to its built-in model
and the browser console says why.
