// src/lib/earth/shaders.ts
// GLSL for the Earth surface, clouds, atmosphere, imagery tiles and point sprites.

export const SURFACE_VERT = /* glsl */ `
varying vec2 vUv;
varying vec3 vPos;
void main() {
  vUv = uv;
  vPos = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

export const EARTH_FRAG = /* glsl */ `
uniform sampler2D dayMap;
uniform sampler2D nightMap;
uniform sampler2D normalMap;
uniform sampler2D waterMap;
uniform sampler2D cloudMap;
uniform vec3 sunDir;
uniform float cloudShadow;
varying vec2 vUv;
varying vec3 vPos;
#ifdef TILE
uniform sampler2D tileNormalMap;
uniform float tileNormal;
uniform float opacity;
varying vec2 vTileUv;
#endif

void main() {
  vec3 N = normalize(vPos);
  vec3 east = vec3(N.z, 0.0, -N.x);
  east = length(east) < 1e-4 ? vec3(0.0, 0.0, -1.0) : normalize(east);
  vec3 north = cross(N, east);
#ifdef TILE
  vec3 tn = (tileNormal > 0.5 ? texture2D(tileNormalMap, vTileUv).xyz : texture2D(normalMap, vUv).xyz) * 2.0 - 1.0;
  vec3 day = texture2D(dayMap, vTileUv).rgb;
#else
  vec3 tn = texture2D(normalMap, vUv).xyz * 2.0 - 1.0;
  vec3 day = texture2D(dayMap, vUv).rgb;
#endif
  float water = texture2D(waterMap, vUv).r;
  vec3 Nb = normalize(mix(tn.x * east + tn.y * north + tn.z * N, N, water));

  vec3 V = normalize(cameraPosition - vPos);
  float cosSun = dot(N, sunDir);
  float cloud = texture2D(cloudMap, vUv).r;

  // Day side: imagery with terrain relief, cloud shadows and warm twilight near the terminator.
  day *= 1.0 - cloudShadow * smoothstep(0.2, 0.9, cloud) * 0.45;
  float diffuse = max(dot(Nb, sunDir), 0.0);
  float relief = mix(1.0, clamp(diffuse / max(cosSun, 0.08), 0.35, 1.8), 0.85);
  float light = smoothstep(-0.08, 0.35, cosSun) * relief;
  vec3 twilight = mix(vec3(1.0, 0.55, 0.32), vec3(1.0), smoothstep(0.0, 0.3, cosSun));
  vec3 color = day * light * twilight * 1.35;

  // Ocean sun glint.
  vec3 H = normalize(sunDir + V);
  float nh = max(dot(N, H), 0.0);
  float glint = (pow(nh, 900.0) * 0.55 + pow(nh, 70.0) * 0.06) * smoothstep(0.6, 0.95, water) * smoothstep(-0.02, 0.15, cosSun);
  color += mix(vec3(0.55, 0.62, 0.7), vec3(1.0, 0.95, 0.85), glint) * glint * (1.0 - cloud * cloudShadow * 0.8);

  // Night side: city lights fade in past the terminator.
  vec3 night = texture2D(nightMap, vUv).rgb;
  float dark = 1.0 - smoothstep(-0.18, 0.06, cosSun);
  color += pow(night, vec3(1.25)) * vec3(1.0, 0.82, 0.56) * 2.4 * dark * (1.0 - smoothstep(0.3, 0.9, cloud) * 0.7);
  color += day * 0.018 * (1.0 - light);   // faint earthshine

  // Rayleigh-like haze toward the limb on the lit hemisphere.
  float fres = pow(1.0 - max(dot(N, V), 0.0), 2.5);
  vec3 sky = mix(vec3(0.85, 0.5, 0.35), vec3(0.32, 0.6, 1.0), smoothstep(-0.12, 0.1, cosSun));
  color = mix(color, sky, fres * smoothstep(-0.15, 0.35, cosSun) * 0.6);

#ifdef TILE
  gl_FragColor = vec4(color, opacity);
#else
  gl_FragColor = vec4(color, 1.0);
#endif
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export const CLOUD_FRAG = /* glsl */ `
uniform sampler2D cloudMap;
uniform vec3 sunDir;
uniform float opacity;
varying vec2 vUv;
varying vec3 vPos;
void main() {
  vec3 N = normalize(vPos);
  float c = smoothstep(0.18, 0.95, texture2D(cloudMap, vUv).r);
  float cosSun = dot(N, sunDir);
  float lit = smoothstep(-0.12, 0.3, cosSun);
  vec3 tint = mix(vec3(1.0, 0.6, 0.4), vec3(1.0), smoothstep(0.0, 0.3, cosSun));
  vec3 color = tint * (0.04 + 0.96 * lit);
  gl_FragColor = vec4(color, c * opacity * mix(0.12, 0.92, lit));
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export const ATMOSPHERE_RADIUS = 1.035;
export const ATMOSPHERE_FRAG = /* glsl */ `
uniform vec3 sunDir;
varying vec3 vPos;
void main() {
  vec3 N = normalize(vPos);
  vec3 V = normalize(cameraPosition - vPos);
  float limb = sqrt(${(ATMOSPHERE_RADIUS ** 2 - 1).toFixed(6)}) / ${ATMOSPHERE_RADIUS.toFixed(3)};
  float t = clamp(-dot(N, V) / limb, 0.0, 1.0);
  float glow = pow(t, 2.2) * (1.0 - smoothstep(0.92, 1.0, t) * 0.35);
  float cosSun = dot(N, sunDir);
  vec3 col = mix(vec3(0.9, 0.5, 0.3), vec3(0.3, 0.58, 1.0), smoothstep(-0.15, 0.1, cosSun));
  float intensity = 1.25 * smoothstep(-0.22, 0.3, cosSun);
  gl_FragColor = vec4(col * glow * intensity, 1.0);
  #include <colorspace_fragment>
}`;

export const TILE_VERT = /* glsl */ `
attribute vec2 tileUv;
varying vec2 vUv;
varying vec2 vTileUv;
varying vec3 vPos;
void main() {
  vUv = uv;
  vTileUv = tileUv;
  vPos = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

export const POINT_VERT = /* glsl */ `
attribute vec4 aColor;
attribute float aSize;
uniform float pixelRatio;
uniform float farPlane;
varying vec4 vColor;
void main() {
  vColor = aColor;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  if (farPlane > 0.5) gl_Position.z = gl_Position.w * 0.99999;
  gl_PointSize = aSize * pixelRatio;
}`;

// shape 0: filled marker with dark outline and halo · 1: ring · 2: soft dot
export const POINT_FRAG = /* glsl */ `
uniform int shape;
varying vec4 vColor;
void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float r = length(p);
  if (r > 1.0) discard;
  float aa = fwidth(r) * 1.2;
  vec4 c;
  if (shape == 0) {
    float core = 1.0 - smoothstep(0.42 - aa, 0.42 + aa, r);
    float outline = 1.0 - smoothstep(0.56 - aa, 0.56 + aa, r);
    float halo = (1.0 - smoothstep(0.56, 1.0, r)) * 0.35;
    vec3 rgb = mix(vec3(0.02, 0.03, 0.05), vColor.rgb, core);
    c = vec4(mix(vColor.rgb, rgb, outline), max(outline, halo) * vColor.a);
  } else if (shape == 1) {
    float ring = smoothstep(0.72 - aa, 0.72 + aa, r) * (1.0 - smoothstep(0.92 - aa, 0.92 + aa, r));
    c = vec4(vColor.rgb, ring * vColor.a);
  } else {
    c = vec4(vColor.rgb, (1.0 - smoothstep(0.2, 1.0, r)) * vColor.a);
  }
  if (c.a < 0.01) discard;
  gl_FragColor = c;
  #include <colorspace_fragment>
}`;
