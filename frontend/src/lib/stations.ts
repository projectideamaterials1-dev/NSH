// src/lib/stations.ts
// Ground stations: the mission's own network (used for uplink windows and contact status, mirrored from
// backend/data/ground_stations.csv) and major real-world tracking networks shown for reference only -
// the backend does not use those for line-of-sight or uplink decisions.

import { GROUND_STATIONS } from './constants';

export type StationRole = 'mission' | 'reference';

export interface Station {
  id: string;
  name: string;
  network: string;
  operator: string;
  country: string;
  lat: number;
  lon: number;
  role: StationRole;
  /** Mission stations: the elevation above the horizon a satellite needs for contact. */
  minElevationDeg?: number;
  /** What the site does (bands, missions it supports). */
  notes: string;
}

const MISSION_META: Record<string, Pick<Station, 'network' | 'operator' | 'country' | 'notes'>> = {
  'GS-001': { network: 'ISTRAC', operator: 'ISRO', country: 'India', notes: 'ISRO Telemetry, Tracking and Command Network headquarters; mission control for ISRO satellites.' },
  'GS-002': { network: 'KSAT', operator: 'Kongsberg Satellite Services', country: 'Norway', notes: 'SvalSat at 78° N sees every polar-orbiting satellite on nearly every orbit.' },
  'GS-003': { network: 'NASA Deep Space Network', operator: 'NASA / JPL', country: 'United States', notes: 'Goldstone Deep Space Communications Complex, Mojave Desert.' },
  'GS-004': { network: 'Commercial', operator: 'Various', country: 'Chile', notes: 'Southern high-latitude site covering polar passes over the South Atlantic and Pacific.' },
  'GS-005': { network: 'University', operator: 'IIT Delhi', country: 'India', notes: 'Academic ground node; high 15° elevation mask (urban horizon).' },
  'GS-006': { network: 'NASA Near Space Network', operator: 'NASA / NSF', country: 'Antarctica', notes: 'McMurdo Ground Station: southern polar contacts.' },
};

const pretty = (name: string) => name.replace(/_/g, ' ');

export const MISSION_STATIONS: Station[] = GROUND_STATIONS.map(gs => ({
  id: gs.id, name: pretty(gs.name), lat: gs.coordinates[1], lon: gs.coordinates[0], role: 'mission',
  minElevationDeg: gs.minElevationAngle,
  ...(MISSION_META[gs.id] ?? { network: 'Mission', operator: '—', country: '—', notes: '' }),
}));

/** Major tracking networks, for reference. Coordinates are approximate (to about 0.1°). */
export const REFERENCE_STATIONS: Station[] = [
  { id: 'DSN-MDSCC', name: 'Madrid (Robledo de Chavela)', network: 'NASA Deep Space Network', operator: 'NASA / INTA', country: 'Spain', lat: 40.43, lon: -4.25, role: 'reference', notes: 'One of the three DSN complexes, ~120° apart in longitude for continuous deep-space coverage.' },
  { id: 'DSN-CDSCC', name: 'Canberra (Tidbinbilla)', network: 'NASA Deep Space Network', operator: 'NASA / CSIRO', country: 'Australia', lat: -35.40, lon: 148.98, role: 'reference', notes: 'Southern DSN complex; the only one that can see spacecraft far south of the ecliptic, such as Voyager 2.' },
  { id: 'NEN-WGS', name: 'Wallops', network: 'NASA Near Space Network', operator: 'NASA', country: 'United States', lat: 37.92, lon: -75.48, role: 'reference', notes: 'Near-Earth tracking and launch range support.' },
  { id: 'NEN-WSC', name: 'White Sands Complex', network: 'NASA Near Space Network', operator: 'NASA', country: 'United States', lat: 32.50, lon: -106.61, role: 'reference', notes: 'Ground terminals for the TDRS relay satellites that carry most ISS communications.' },
  { id: 'NEN-ASF', name: 'Fairbanks (ASF)', network: 'NASA Near Space Network', operator: 'NASA / Univ. of Alaska', country: 'United States', lat: 64.86, lon: -147.85, role: 'reference', notes: 'High-latitude site for polar-orbiting Earth-observation satellites.' },
  { id: 'ESA-KIR', name: 'Kiruna', network: 'ESA ESTRACK', operator: 'ESA', country: 'Sweden', lat: 67.86, lon: 20.96, role: 'reference', notes: 'Polar-orbit support for ESA Earth-observation missions.' },
  { id: 'ESA-RED', name: 'Redu', network: 'ESA ESTRACK', operator: 'ESA', country: 'Belgium', lat: 50.00, lon: 5.15, role: 'reference', notes: 'In-orbit testing and operations for ESA satellites.' },
  { id: 'ESA-KOU', name: 'Kourou', network: 'ESA ESTRACK', operator: 'ESA / CNES', country: 'French Guiana', lat: 5.25, lon: -52.80, role: 'reference', notes: 'Near-equatorial site; supports launches from the Guiana Space Centre.' },
  { id: 'ESA-NNO', name: 'New Norcia', network: 'ESA ESTRACK', operator: 'ESA', country: 'Australia', lat: -31.05, lon: 116.19, role: 'reference', notes: '35 m deep-space antenna.' },
  { id: 'ESA-CEB', name: 'Cebreros', network: 'ESA ESTRACK', operator: 'ESA', country: 'Spain', lat: 40.45, lon: -4.37, role: 'reference', notes: '35 m deep-space antenna.' },
  { id: 'ESA-MLG', name: 'Malargüe', network: 'ESA ESTRACK', operator: 'ESA', country: 'Argentina', lat: -35.78, lon: -69.40, role: 'reference', notes: '35 m deep-space antenna.' },
  { id: 'KSAT-TRL', name: 'TrollSat', network: 'KSAT', operator: 'Kongsberg Satellite Services', country: 'Antarctica', lat: -72.01, lon: 2.54, role: 'reference', notes: 'Antarctic counterpart to SvalSat: two contacts per orbit for polar satellites.' },
  { id: 'ISRO-IDSN', name: 'Byalalu (IDSN)', network: 'Indian Deep Space Network', operator: 'ISRO', country: 'India', lat: 12.90, lon: 77.37, role: 'reference', notes: '32 m antenna supporting Chandrayaan, Mangalyaan and Aditya-L1.' },
  { id: 'CN-KAS', name: 'Kashgar', network: 'China Deep Space Network', operator: 'CNSA / CLTC', country: 'China', lat: 39.5, lon: 76.0, role: 'reference', notes: 'Deep-space station supporting Chang’e and Tianwen missions.' },
  { id: 'CN-JMS', name: 'Jiamusi', network: 'China Deep Space Network', operator: 'CNSA / CLTC', country: 'China', lat: 46.8, lon: 130.3, role: 'reference', notes: '66 m deep-space antenna.' },
];

export const STATION_COLORS: Record<StationRole, string> = { mission: '#e6edf3', reference: '#f0883e' };
