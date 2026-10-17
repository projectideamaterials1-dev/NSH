// src/lib/library.ts
// Reference data for the Library page: present-day space stations, and the Sun, planets and dwarf planets
// with their major moons and the spacecraft working there.
//
// Physical values (GM, radius, orbit) are standard constants; each body carries GM and mean radius - what
// a two-body / J2 propagator needs for its central body - so this table can seed Moon / Mars / other-body
// support later. Moon counts and the spacecraft lists change: they reflect what was known as of AS_OF.

export const AS_OF = 'mid-2026';

export interface SpaceStation {
  name: string;
  /** Catalog IDs to look up in the live fleet (CelesTrak names). */
  catalogIds: string[];
  operators: string;
  firstLaunch: string;
  orbit: string;
  inclinationDeg: number;
  massT: string;
  crew: string;
  modules: string[];
  notes: string;
}

export const SPACE_STATIONS: SpaceStation[] = [
  {
    name: 'International Space Station (ISS)',
    catalogIds: ['ISS (ZARYA)', 'ISS (NAUKA)', 'POISK'],
    operators: 'NASA, Roscosmos, ESA, JAXA, CSA',
    firstLaunch: '1998 (Zarya); continuously crewed since November 2000',
    orbit: 'Low Earth orbit, about 400–420 km',
    inclinationDeg: 51.64,
    massT: '≈ 420 t',
    crew: 'Usually 7 (more during handovers)',
    modules: ['Zarya', 'Unity', 'Zvezda', 'Destiny', 'Harmony', 'Tranquility', 'Columbus', 'Kibō', 'Nauka', 'Prichal',
      'Poisk', 'Rassvet', 'Leonardo', 'BEAM', 'Cupola'],
    notes: 'Largest structure humans have put in orbit. Visiting vehicles (Soyuz, Progress, Crew/Cargo Dragon, Cygnus) dock for weeks to months; the dashboard treats them as attached, not as collision risks.',
  },
  {
    name: 'Tiangong (China Space Station)',
    catalogIds: ['CSS (TIANHE)', 'CSS (WENTIAN)', 'CSS (MENGTIAN)'],
    operators: 'China Manned Space Agency (CMSA)',
    firstLaunch: '2021 (Tianhe core module); completed 2022',
    orbit: 'Low Earth orbit, about 380–400 km',
    inclinationDeg: 41.5,
    massT: '≈ 100 t',
    crew: '3 (6 during crew handovers)',
    modules: ['Tianhe (core)', 'Wentian (lab)', 'Mengtian (lab)'],
    notes: 'Visited by Shenzhou crew ships and Tianzhou cargo ships.',
  },
];

export type BodyKind = 'star' | 'planet' | 'dwarf planet' | 'moon';

export interface Moon {
  name: string;
  radiusKm: number;
  notes?: string;
}

export interface Spacecraft {
  name: string;
  agency: string;
  since: string;
  role: 'orbiter' | 'lander' | 'rover' | 'en route' | 'solar observatory' | 'relay';
  notes?: string;
}

export interface Body {
  name: string;
  kind: BodyKind;
  /** Gravitational parameter GM, km³/s². */
  gmKm3s2: number | null;
  meanRadiusKm: number;
  /** Mean distance from the Sun (semi-major axis), AU; null for the Sun. */
  smaAu: number | null;
  /** Sidereal orbital period, days. */
  orbitalPeriodDays: number | null;
  /** Sidereal rotation period, hours (negative = retrograde). */
  rotationHours: number;
  knownMoons: number | null;
  majorMoons: Moon[];
  spacecraft: Spacecraft[];
  summary: string;
}

export const SOLAR_SYSTEM: Body[] = [
  {
    name: 'Sun', kind: 'star', gmKm3s2: 132712440018, meanRadiusKm: 695700, smaAu: null, orbitalPeriodDays: null,
    rotationHours: 609.12, knownMoons: null, majorMoons: [],
    spacecraft: [
      { name: 'Parker Solar Probe', agency: 'NASA', since: '2018', role: 'solar observatory', notes: 'Closest approaches ~6 million km from the surface.' },
      { name: 'Solar Orbiter', agency: 'ESA / NASA', since: '2020', role: 'solar observatory', notes: 'First images of the Sun’s poles.' },
      { name: 'SOHO', agency: 'ESA / NASA', since: '1995', role: 'solar observatory', notes: 'At the Sun–Earth L1 point.' },
      { name: 'Aditya-L1', agency: 'ISRO', since: '2023', role: 'solar observatory', notes: 'Halo orbit around Sun–Earth L1.' },
      { name: 'STEREO-A', agency: 'NASA', since: '2006', role: 'solar observatory' },
    ],
    summary: 'G-type main-sequence star holding 99.86 % of the Solar System’s mass; its activity (F10.7 flux, geomagnetic Kp) drives the atmospheric drag the dashboard models.',
  },
  {
    name: 'Mercury', kind: 'planet', gmKm3s2: 22031.868, meanRadiusKm: 2439.4, smaAu: 0.387, orbitalPeriodDays: 87.97,
    rotationHours: 1407.6, knownMoons: 0, majorMoons: [],
    spacecraft: [{ name: 'BepiColombo', agency: 'ESA / JAXA', since: '2018', role: 'en route', notes: 'Two orbiters; Mercury orbit insertion planned for late 2026.' }],
    summary: 'Smallest planet and closest to the Sun; no atmosphere to speak of, large iron core.',
  },
  {
    name: 'Venus', kind: 'planet', gmKm3s2: 324858.59, meanRadiusKm: 6051.8, smaAu: 0.723, orbitalPeriodDays: 224.70,
    rotationHours: -5832.5, knownMoons: 0, majorMoons: [],
    spacecraft: [],
    summary: 'Dense CO₂ atmosphere (~92 bar at the surface) and the hottest surface in the Solar System; rotates backwards. No spacecraft currently in orbit.',
  },
  {
    name: 'Earth', kind: 'planet', gmKm3s2: 398600.4418, meanRadiusKm: 6371.0, smaAu: 1.000, orbitalPeriodDays: 365.256,
    rotationHours: 23.934, knownMoons: 1,
    majorMoons: [{ name: 'Moon', radiusKm: 1737.4, notes: 'GM 4,902.8 km³/s²; mean distance 384,400 km.' }],
    spacecraft: [{ name: 'The live fleet in this dashboard', agency: 'Various', since: '—', role: 'orbiter', notes: 'Every active satellite NORAD publishes; see the map.' }],
    summary: 'The only body this dashboard currently simulates: J2 gravity, drag and SGP4 element sets are all Earth-specific today.',
  },
  {
    name: 'Moon', kind: 'moon', gmKm3s2: 4902.800, meanRadiusKm: 1737.4, smaAu: 1.000, orbitalPeriodDays: 27.322,
    rotationHours: 655.72, knownMoons: 0, majorMoons: [],
    spacecraft: [
      { name: 'Lunar Reconnaissance Orbiter', agency: 'NASA', since: '2009', role: 'orbiter' },
      { name: 'Chandrayaan-2 orbiter', agency: 'ISRO', since: '2019', role: 'orbiter' },
      { name: 'Danuri (KPLO)', agency: 'KARI', since: '2022', role: 'orbiter' },
      { name: 'Queqiao-2', agency: 'CNSA', since: '2024', role: 'relay', notes: 'Relays far-side lander communications.' },
      { name: 'ARTEMIS P1 / P2', agency: 'NASA', since: '2011', role: 'orbiter', notes: 'Former THEMIS probes in lunar orbit.' },
    ],
    summary: 'Earth’s only natural satellite, tidally locked. Lunar orbits are unstable without station-keeping because of mascons (uneven gravity).',
  },
  {
    name: 'Mars', kind: 'planet', gmKm3s2: 42828.37, meanRadiusKm: 3389.5, smaAu: 1.524, orbitalPeriodDays: 686.98,
    rotationHours: 24.623, knownMoons: 2,
    majorMoons: [{ name: 'Phobos', radiusKm: 11.1, notes: 'Spiralling inward; expected to break up in tens of millions of years.' },
      { name: 'Deimos', radiusKm: 6.2 }],
    spacecraft: [
      { name: '2001 Mars Odyssey', agency: 'NASA', since: '2001', role: 'orbiter' },
      { name: 'Mars Express', agency: 'ESA', since: '2003', role: 'orbiter' },
      { name: 'Mars Reconnaissance Orbiter', agency: 'NASA', since: '2006', role: 'orbiter' },
      { name: 'MAVEN', agency: 'NASA', since: '2014', role: 'orbiter' },
      { name: 'ExoMars Trace Gas Orbiter', agency: 'ESA / Roscosmos', since: '2016', role: 'orbiter' },
      { name: 'Hope', agency: 'UAE (MBRSC)', since: '2021', role: 'orbiter' },
      { name: 'Tianwen-1 orbiter', agency: 'CNSA', since: '2021', role: 'orbiter' },
      { name: 'Curiosity', agency: 'NASA', since: '2012', role: 'rover' },
      { name: 'Perseverance', agency: 'NASA', since: '2021', role: 'rover', notes: 'With the Ingenuity helicopter, retired in 2024.' },
    ],
    summary: 'Thin CO₂ atmosphere (~0.6 % of Earth’s surface pressure); the most-visited planet after Earth.',
  },
  {
    name: 'Ceres', kind: 'dwarf planet', gmKm3s2: 62.6284, meanRadiusKm: 469.7, smaAu: 2.77, orbitalPeriodDays: 1680,
    rotationHours: 9.074, knownMoons: 0, majorMoons: [], spacecraft: [],
    summary: 'Largest object in the asteroid belt; mapped by NASA’s Dawn (2015–2018, now an inactive orbiter).',
  },
  {
    name: 'Jupiter', kind: 'planet', gmKm3s2: 126686534, meanRadiusKm: 69911, smaAu: 5.203, orbitalPeriodDays: 4332.6,
    rotationHours: 9.925, knownMoons: 97,
    majorMoons: [
      { name: 'Io', radiusKm: 1821.6, notes: 'Most volcanically active body known.' },
      { name: 'Europa', radiusKm: 1560.8, notes: 'Subsurface ocean under an ice shell.' },
      { name: 'Ganymede', radiusKm: 2634.1, notes: 'Largest moon in the Solar System; has its own magnetic field.' },
      { name: 'Callisto', radiusKm: 2410.3 },
    ],
    spacecraft: [
      { name: 'Juno', agency: 'NASA', since: '2016', role: 'orbiter' },
      { name: 'Juice', agency: 'ESA', since: '2023', role: 'en route', notes: 'Arrives 2031; will end in orbit around Ganymede.' },
      { name: 'Europa Clipper', agency: 'NASA', since: '2024', role: 'en route', notes: 'Arrives 2030.' },
    ],
    summary: 'Largest planet, more than twice the mass of all the other planets combined.',
  },
  {
    name: 'Saturn', kind: 'planet', gmKm3s2: 37931187, meanRadiusKm: 58232, smaAu: 9.537, orbitalPeriodDays: 10759,
    rotationHours: 10.656, knownMoons: 274,
    majorMoons: [
      { name: 'Titan', radiusKm: 2574.7, notes: 'Thick nitrogen atmosphere and methane lakes; NASA’s Dragonfly launches in 2028.' },
      { name: 'Rhea', radiusKm: 763.8 }, { name: 'Iapetus', radiusKm: 734.5 }, { name: 'Dione', radiusKm: 561.4 },
      { name: 'Tethys', radiusKm: 531.1 },
      { name: 'Enceladus', radiusKm: 252.1, notes: 'Water plumes from a subsurface ocean.' },
      { name: 'Mimas', radiusKm: 198.2 },
    ],
    spacecraft: [],
    summary: 'Ring system mostly of water ice. Cassini orbited it 2004–2017; no spacecraft there now.',
  },
  {
    name: 'Uranus', kind: 'planet', gmKm3s2: 5793939, meanRadiusKm: 25362, smaAu: 19.19, orbitalPeriodDays: 30687,
    rotationHours: -17.24, knownMoons: 29,
    majorMoons: [
      { name: 'Titania', radiusKm: 788.4 }, { name: 'Oberon', radiusKm: 761.4 }, { name: 'Umbriel', radiusKm: 584.7 },
      { name: 'Ariel', radiusKm: 578.9 }, { name: 'Miranda', radiusKm: 235.8 },
    ],
    spacecraft: [],
    summary: 'Ice giant tipped on its side (98° axial tilt). Visited once, by Voyager 2 in 1986.',
  },
  {
    name: 'Neptune', kind: 'planet', gmKm3s2: 6836529, meanRadiusKm: 24622, smaAu: 30.07, orbitalPeriodDays: 60190,
    rotationHours: 16.11, knownMoons: 16,
    majorMoons: [{ name: 'Triton', radiusKm: 1353.4, notes: 'Retrograde orbit: probably a captured Kuiper-belt object.' },
      { name: 'Proteus', radiusKm: 210 }, { name: 'Nereid', radiusKm: 170 }],
    spacecraft: [],
    summary: 'Outermost planet; strongest winds measured in the Solar System. Visited once, by Voyager 2 in 1989.',
  },
  {
    name: 'Pluto', kind: 'dwarf planet', gmKm3s2: 869.6, meanRadiusKm: 1188.3, smaAu: 39.48, orbitalPeriodDays: 90560,
    rotationHours: -153.29, knownMoons: 5,
    majorMoons: [{ name: 'Charon', radiusKm: 606, notes: 'So large that Pluto and Charon orbit a point between them.' },
      { name: 'Nix', radiusKm: 25 }, { name: 'Hydra', radiusKm: 25 }, { name: 'Kerberos', radiusKm: 6 }, { name: 'Styx', radiusKm: 6 }],
    spacecraft: [],
    summary: 'Largest known Kuiper-belt object; flown past by New Horizons in 2015.',
  },
  {
    name: 'Haumea', kind: 'dwarf planet', gmKm3s2: 267.0, meanRadiusKm: 780, smaAu: 43.1, orbitalPeriodDays: 103400,
    rotationHours: 3.92, knownMoons: 2,
    majorMoons: [{ name: 'Hiʻiaka', radiusKm: 160 }, { name: 'Namaka', radiusKm: 85 }],
    spacecraft: [],
    summary: 'Elongated by its fast spin (about 4 hours); has a ring.',
  },
  {
    name: 'Makemake', kind: 'dwarf planet', gmKm3s2: null, meanRadiusKm: 715, smaAu: 45.4, orbitalPeriodDays: 111800,
    rotationHours: 22.8, knownMoons: 1, majorMoons: [{ name: 'MK2', radiusKm: 80 }],
    spacecraft: [],
    summary: 'Bright Kuiper-belt dwarf planet; its mass is not yet well measured.',
  },
  {
    name: 'Eris', kind: 'dwarf planet', gmKm3s2: 1108, meanRadiusKm: 1163, smaAu: 67.8, orbitalPeriodDays: 204200,
    rotationHours: 378.9, knownMoons: 1, majorMoons: [{ name: 'Dysnomia', radiusKm: 350 }],
    spacecraft: [],
    summary: 'Most massive known dwarf planet; its discovery in 2005 led to Pluto’s reclassification.',
  },
];
