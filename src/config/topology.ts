import type { NetworkNode, NetworkLink, NodeType } from '../types/network'
import { latLongToVec3, angularDistance } from './globe'

// ===========================================================================
// Global internet topology — real cities, internet exchanges, hyperscale data
// centers and submarine-cable landing stations placed at their true lat/long
// on the 3D globe. Links approximate the major terrestrial and subsea routes.
// ===========================================================================
//
// Traffic: a user city → its regional backbone/IXP → across continents over
// submarine cables (via landing stations) → a data center → a server, then a
// response retraces the path home. Routing is shortest-path by latency, so it
// naturally picks the lowest-latency intercontinental route.
// ---------------------------------------------------------------------------

interface NodeDef {
  id: string
  type: NodeType
  lat: number
  long: number
  label: string
  sub?: string
}

const NODE_DEFS: NodeDef[] = [
  // --- Backbone routers / internet exchange points ---
  { id: 'core-ny',  type: 'core-router', lat: 40.7, long: -74.0, label: 'New York', sub: 'IXP' },
  { id: 'core-sjc', type: 'core-router', lat: 37.3, long: -121.9, label: 'San Jose', sub: 'IXP' },
  { id: 'core-lon', type: 'core-router', lat: 51.5, long: -0.1, label: 'London', sub: 'LINX' },
  { id: 'core-ams', type: 'core-router', lat: 52.4, long: 4.9, label: 'Amsterdam', sub: 'AMS-IX' },
  { id: 'core-fra', type: 'core-router', lat: 50.1, long: 8.7, label: 'Frankfurt', sub: 'DE-CIX' },
  { id: 'core-bom', type: 'core-router', lat: 19.1, long: 72.9, label: 'Mumbai', sub: 'IXP' },
  { id: 'core-sin', type: 'core-router', lat: 1.35, long: 103.8, label: 'Singapore', sub: 'IXP' },
  { id: 'core-hkg', type: 'core-router', lat: 22.3, long: 114.2, label: 'Hong Kong', sub: 'IXP' },
  { id: 'core-tyo', type: 'core-router', lat: 35.7, long: 139.7, label: 'Tokyo', sub: 'IXP' },
  { id: 'core-sao', type: 'core-router', lat: -23.5, long: -46.6, label: 'Sao Paulo', sub: 'IXP' },
  { id: 'core-syd', type: 'core-router', lat: -33.9, long: 151.2, label: 'Sydney', sub: 'IXP' },
  { id: 'core-jnb', type: 'core-router', lat: -26.2, long: 28.0, label: 'Johannesburg', sub: 'IXP' },

  // --- Submarine-cable landing / transit hubs ---
  { id: 'gw-lax', type: 'gateway', lat: 34.0, long: -118.2, label: 'Los Angeles', sub: 'Cable landing' },
  { id: 'gw-mia', type: 'gateway', lat: 25.8, long: -80.2, label: 'Miami', sub: 'Cable landing' },
  { id: 'gw-mrs', type: 'gateway', lat: 43.3, long: 5.4, label: 'Marseille', sub: 'Cable hub' },
  { id: 'gw-fjr', type: 'gateway', lat: 25.1, long: 56.3, label: 'Fujairah', sub: 'Cable hub' },
  { id: 'gw-lag', type: 'gateway', lat: 6.5, long: 3.4, label: 'Lagos', sub: 'Cable landing' },

  // --- Hyperscale data centers ---
  { id: 'dc-ash', type: 'datacenter', lat: 40.65, long: -74.1, label: 'US-East DC', sub: 'us-east' },
  { id: 'dc-fra', type: 'datacenter', lat: 50.0, long: 8.6, label: 'Frankfurt DC', sub: 'eu-central' },
  { id: 'dc-sin', type: 'datacenter', lat: 1.3, long: 103.7, label: 'Singapore DC', sub: 'ap-southeast' },
  { id: 'dc-tyo', type: 'datacenter', lat: 35.6, long: 139.8, label: 'Tokyo DC', sub: 'ap-northeast' },

  // --- Servers inside the data centers ---
  { id: 'srv-ash1', type: 'server', lat: 40.6, long: -74.0, label: 'us-east-web' },
  { id: 'srv-ash2', type: 'server', lat: 40.7, long: -74.2, label: 'us-east-api' },
  { id: 'srv-fra1', type: 'server', lat: 50.05, long: 8.5, label: 'eu-web' },
  { id: 'srv-sin1', type: 'server', lat: 1.25, long: 103.65, label: 'ap-web' },
  { id: 'srv-tyo1', type: 'server', lat: 35.55, long: 139.9, label: 'ap-ne-web' },
]

// Assign a plausible public IP per node, with a different first octet per tier
// so the addresses look realistic and inspectable.
const IP_BLOCK: Record<NodeType, number> = {
  home: 24,
  'home-router': 192,
  'isp-router': 100,
  'core-router': 80,
  gateway: 62,
  datacenter: 104,
  server: 151,
}

function ipFor(type: NodeType, i: number): string {
  const a = IP_BLOCK[type] ?? 10
  const b = ((i * 37 + 11) % 254) + 1
  const c = ((i * 53 + 7) % 254) + 1
  const d = ((i * 97 + 3) % 254) + 1
  return `${a}.${b}.${c}.${d}`
}

// Major world cities (metros that generate user traffic). Each is auto-wired to
// its nearest backbone hub below, so the routing graph stays connected without
// hand-authoring every link. Cities already present as backbone hubs above
// (London, Tokyo, Mumbai, …) are intentionally omitted to avoid duplicates.
const WORLD_CITIES: { name: string; country: string; lat: number; long: number }[] = [
  // North America
  { name: 'Chicago', country: 'USA', lat: 41.88, long: -87.63 },
  { name: 'Toronto', country: 'Canada', lat: 43.65, long: -79.38 },
  { name: 'Montreal', country: 'Canada', lat: 45.50, long: -73.57 },
  { name: 'Vancouver', country: 'Canada', lat: 49.28, long: -123.12 },
  { name: 'Seattle', country: 'USA', lat: 47.61, long: -122.33 },
  { name: 'Dallas', country: 'USA', lat: 32.78, long: -96.80 },
  { name: 'Atlanta', country: 'USA', lat: 33.75, long: -84.39 },
  { name: 'Denver', country: 'USA', lat: 39.74, long: -104.99 },
  { name: 'Mexico City', country: 'Mexico', lat: 19.43, long: -99.13 },
  // South America
  { name: 'Buenos Aires', country: 'Argentina', lat: -34.60, long: -58.38 },
  { name: 'Rio de Janeiro', country: 'Brazil', lat: -22.91, long: -43.17 },
  { name: 'Lima', country: 'Peru', lat: -12.05, long: -77.04 },
  { name: 'Bogota', country: 'Colombia', lat: 4.71, long: -74.07 },
  { name: 'Santiago', country: 'Chile', lat: -33.45, long: -70.67 },
  { name: 'Caracas', country: 'Venezuela', lat: 10.48, long: -66.90 },
  // Europe
  { name: 'Paris', country: 'France', lat: 48.85, long: 2.35 },
  { name: 'Madrid', country: 'Spain', lat: 40.42, long: -3.70 },
  { name: 'Barcelona', country: 'Spain', lat: 41.39, long: 2.17 },
  { name: 'Rome', country: 'Italy', lat: 41.90, long: 12.50 },
  { name: 'Milan', country: 'Italy', lat: 45.46, long: 9.19 },
  { name: 'Berlin', country: 'Germany', lat: 52.52, long: 13.40 },
  { name: 'Munich', country: 'Germany', lat: 48.14, long: 11.58 },
  { name: 'Moscow', country: 'Russia', lat: 55.75, long: 37.62 },
  { name: 'Istanbul', country: 'Turkey', lat: 41.01, long: 28.98 },
  { name: 'Warsaw', country: 'Poland', lat: 52.23, long: 21.01 },
  { name: 'Stockholm', country: 'Sweden', lat: 59.33, long: 18.07 },
  { name: 'Vienna', country: 'Austria', lat: 48.21, long: 16.37 },
  { name: 'Zurich', country: 'Switzerland', lat: 47.37, long: 8.54 },
  { name: 'Dublin', country: 'Ireland', lat: 53.35, long: -6.26 },
  { name: 'Lisbon', country: 'Portugal', lat: 38.72, long: -9.14 },
  { name: 'Athens', country: 'Greece', lat: 37.98, long: 23.73 },
  { name: 'Kyiv', country: 'Ukraine', lat: 50.45, long: 30.52 },
  // Africa
  { name: 'Cairo', country: 'Egypt', lat: 30.04, long: 31.24 },
  { name: 'Nairobi', country: 'Kenya', lat: -1.29, long: 36.82 },
  { name: 'Casablanca', country: 'Morocco', lat: 33.57, long: -7.59 },
  { name: 'Cape Town', country: 'South Africa', lat: -33.92, long: 18.42 },
  { name: 'Accra', country: 'Ghana', lat: 5.60, long: -0.19 },
  { name: 'Addis Ababa', country: 'Ethiopia', lat: 9.03, long: 38.74 },
  { name: 'Algiers', country: 'Algeria', lat: 36.75, long: 3.06 },
  // Middle East
  { name: 'Dubai', country: 'UAE', lat: 25.20, long: 55.27 },
  { name: 'Riyadh', country: 'Saudi Arabia', lat: 24.71, long: 46.68 },
  { name: 'Tel Aviv', country: 'Israel', lat: 32.07, long: 34.78 },
  { name: 'Tehran', country: 'Iran', lat: 35.69, long: 51.39 },
  { name: 'Doha', country: 'Qatar', lat: 25.29, long: 51.53 },
  { name: 'Baghdad', country: 'Iraq', lat: 33.31, long: 44.36 },
  // South & Central Asia
  { name: 'Delhi', country: 'India', lat: 28.61, long: 77.21 },
  { name: 'Bangalore', country: 'India', lat: 12.97, long: 77.59 },
  { name: 'Chennai', country: 'India', lat: 13.08, long: 80.27 },
  { name: 'Karachi', country: 'Pakistan', lat: 24.86, long: 67.01 },
  { name: 'Dhaka', country: 'Bangladesh', lat: 23.81, long: 90.41 },
  { name: 'Colombo', country: 'Sri Lanka', lat: 6.93, long: 79.86 },
  // East & Southeast Asia
  { name: 'Bangkok', country: 'Thailand', lat: 13.76, long: 100.50 },
  { name: 'Jakarta', country: 'Indonesia', lat: -6.21, long: 106.85 },
  { name: 'Manila', country: 'Philippines', lat: 14.60, long: 120.98 },
  { name: 'Kuala Lumpur', country: 'Malaysia', lat: 3.14, long: 101.69 },
  { name: 'Ho Chi Minh City', country: 'Vietnam', lat: 10.82, long: 106.63 },
  { name: 'Hanoi', country: 'Vietnam', lat: 21.03, long: 105.85 },
  { name: 'Seoul', country: 'South Korea', lat: 37.57, long: 126.98 },
  { name: 'Beijing', country: 'China', lat: 39.90, long: 116.41 },
  { name: 'Shanghai', country: 'China', lat: 31.23, long: 121.47 },
  { name: 'Shenzhen', country: 'China', lat: 22.54, long: 114.06 },
  { name: 'Taipei', country: 'Taiwan', lat: 25.03, long: 121.57 },
  { name: 'Osaka', country: 'Japan', lat: 34.69, long: 135.50 },
  // Oceania
  { name: 'Melbourne', country: 'Australia', lat: -37.81, long: 144.96 },
  { name: 'Perth', country: 'Australia', lat: -31.95, long: 115.86 },
  { name: 'Brisbane', country: 'Australia', lat: -27.47, long: 153.03 },
  { name: 'Auckland', country: 'New Zealand', lat: -36.85, long: 174.76 },
]

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-')

const CITY_DEFS: NodeDef[] = WORLD_CITIES.map(c => ({
  id: `city-${slug(c.name)}`,
  type: 'home',
  lat: c.lat,
  long: c.long,
  label: c.name,
  sub: c.country,
}))

const ALL_DEFS: NodeDef[] = [...NODE_DEFS, ...CITY_DEFS]

// Continent per country (for world cities) and per backbone-node id (curated).
const COUNTRY_CONTINENT: Record<string, string> = {
  USA: 'North America', Canada: 'North America', Mexico: 'North America',
  Argentina: 'South America', Brazil: 'South America', Peru: 'South America',
  Colombia: 'South America', Chile: 'South America', Venezuela: 'South America',
  France: 'Europe', Spain: 'Europe', Italy: 'Europe', Germany: 'Europe',
  Russia: 'Europe', Turkey: 'Europe', Poland: 'Europe', Sweden: 'Europe',
  Austria: 'Europe', Switzerland: 'Europe', Ireland: 'Europe', Portugal: 'Europe',
  Greece: 'Europe', Ukraine: 'Europe',
  Egypt: 'Africa', Kenya: 'Africa', Morocco: 'Africa', 'South Africa': 'Africa',
  Ghana: 'Africa', Ethiopia: 'Africa', Algeria: 'Africa', Tanzania: 'Africa',
  UAE: 'Asia', 'Saudi Arabia': 'Asia', Israel: 'Asia', Iran: 'Asia', Qatar: 'Asia',
  Iraq: 'Asia', India: 'Asia', Pakistan: 'Asia', Bangladesh: 'Asia',
  'Sri Lanka': 'Asia', Thailand: 'Asia', Indonesia: 'Asia', Philippines: 'Asia',
  Malaysia: 'Asia', Vietnam: 'Asia', 'South Korea': 'Asia', China: 'Asia',
  Taiwan: 'Asia', Japan: 'Asia',
  Australia: 'Oceania', 'New Zealand': 'Oceania',
}

const HUB_CONTINENT: Record<string, string> = {
  'core-ny': 'North America', 'core-sjc': 'North America', 'gw-lax': 'North America',
  'gw-mia': 'North America', 'dc-ash': 'North America', 'srv-ash1': 'North America',
  'srv-ash2': 'North America',
  'core-lon': 'Europe', 'core-ams': 'Europe', 'core-fra': 'Europe', 'gw-mrs': 'Europe',
  'dc-fra': 'Europe', 'srv-fra1': 'Europe',
  'core-bom': 'Asia', 'core-sin': 'Asia', 'core-hkg': 'Asia', 'core-tyo': 'Asia',
  'gw-fjr': 'Asia', 'dc-sin': 'Asia', 'dc-tyo': 'Asia', 'srv-sin1': 'Asia', 'srv-tyo1': 'Asia',
  'core-sao': 'South America',
  'core-syd': 'Oceania',
  'core-jnb': 'Africa', 'gw-lag': 'Africa',
}

function continentFor(d: NodeDef): string {
  return HUB_CONTINENT[d.id] ?? (d.sub ? COUNTRY_CONTINENT[d.sub] : undefined) ?? 'Other'
}

export const INITIAL_NODES: NetworkNode[] = ALL_DEFS.map((d, i) => ({
  id: d.id,
  type: d.type,
  label: d.label,
  subLabel: d.sub,
  ip: ipFor(d.type, i),
  continent: continentFor(d),
  position: latLongToVec3(d.lat, d.long),
  active: true,
}))

// Latency is one-way milliseconds, roughly proportional to real distance, so
// intercontinental hops dominate the round-trip time.
const BACKBONE_LINKS: NetworkLink[] = [
  // North America
  { id: 'l-ny-sjc', sourceId: 'core-ny', targetId: 'core-sjc', latency: 30, bandwidth: 500 },
  { id: 'l-ny-ash', sourceId: 'core-ny', targetId: 'dc-ash', latency: 3, bandwidth: 500 },
  { id: 'l-sjc-lax', sourceId: 'core-sjc', targetId: 'gw-lax', latency: 6, bandwidth: 500 },
  { id: 'l-ny-mia', sourceId: 'core-ny', targetId: 'gw-mia', latency: 25, bandwidth: 400 },
  { id: 'l-ash-s1', sourceId: 'dc-ash', targetId: 'srv-ash1', latency: 1, bandwidth: 800 },
  { id: 'l-ash-s2', sourceId: 'dc-ash', targetId: 'srv-ash2', latency: 1, bandwidth: 800 },

  // Transatlantic
  { id: 'l-ny-lon', sourceId: 'core-ny', targetId: 'core-lon', latency: 35, bandwidth: 500 },
  { id: 'l-ny-ams', sourceId: 'core-ny', targetId: 'core-ams', latency: 38, bandwidth: 500 },

  // Europe
  { id: 'l-lon-ams', sourceId: 'core-lon', targetId: 'core-ams', latency: 8, bandwidth: 500 },
  { id: 'l-ams-fra', sourceId: 'core-ams', targetId: 'core-fra', latency: 7, bandwidth: 500 },
  { id: 'l-lon-fra', sourceId: 'core-lon', targetId: 'core-fra', latency: 10, bandwidth: 500 },
  { id: 'l-fra-dc', sourceId: 'core-fra', targetId: 'dc-fra', latency: 2, bandwidth: 600 },
  { id: 'l-fra-s1', sourceId: 'dc-fra', targetId: 'srv-fra1', latency: 1, bandwidth: 800 },
  { id: 'l-fra-mrs', sourceId: 'core-fra', targetId: 'gw-mrs', latency: 12, bandwidth: 500 },
  { id: 'l-lon-lag', sourceId: 'core-lon', targetId: 'gw-lag', latency: 55, bandwidth: 300 },

  // US ↔ South America
  { id: 'l-mia-sao', sourceId: 'gw-mia', targetId: 'core-sao', latency: 60, bandwidth: 300 },

  // Mediterranean ↔ Middle East ↔ India
  { id: 'l-mrs-fjr', sourceId: 'gw-mrs', targetId: 'gw-fjr', latency: 45, bandwidth: 400 },
  { id: 'l-fjr-bom', sourceId: 'gw-fjr', targetId: 'core-bom', latency: 35, bandwidth: 400 },
  { id: 'l-mrs-bom', sourceId: 'gw-mrs', targetId: 'core-bom', latency: 60, bandwidth: 400 },

  // Africa
  { id: 'l-lag-jnb', sourceId: 'gw-lag', targetId: 'core-jnb', latency: 50, bandwidth: 250 },
  { id: 'l-jnb-bom', sourceId: 'core-jnb', targetId: 'core-bom', latency: 70, bandwidth: 250 },

  // Asia / Oceania
  { id: 'l-bom-sin', sourceId: 'core-bom', targetId: 'core-sin', latency: 35, bandwidth: 500 },
  { id: 'l-sin-hkg', sourceId: 'core-sin', targetId: 'core-hkg', latency: 18, bandwidth: 500 },
  { id: 'l-hkg-tyo', sourceId: 'core-hkg', targetId: 'core-tyo', latency: 25, bandwidth: 500 },
  { id: 'l-sin-dc', sourceId: 'core-sin', targetId: 'dc-sin', latency: 2, bandwidth: 600 },
  { id: 'l-sin-s1', sourceId: 'dc-sin', targetId: 'srv-sin1', latency: 1, bandwidth: 800 },
  { id: 'l-tyo-dc', sourceId: 'core-tyo', targetId: 'dc-tyo', latency: 2, bandwidth: 600 },
  { id: 'l-tyo-s1', sourceId: 'dc-tyo', targetId: 'srv-tyo1', latency: 1, bandwidth: 800 },
  { id: 'l-sin-syd', sourceId: 'core-sin', targetId: 'core-syd', latency: 50, bandwidth: 400 },

  // Trans-Pacific
  { id: 'l-tyo-lax', sourceId: 'core-tyo', targetId: 'gw-lax', latency: 55, bandwidth: 500 },
  { id: 'l-hkg-lax', sourceId: 'core-hkg', targetId: 'gw-lax', latency: 75, bandwidth: 400 },
  { id: 'l-syd-lax', sourceId: 'core-syd', targetId: 'gw-lax', latency: 70, bandwidth: 400 },
]

// Auto-wire each world city to its nearest backbone hub (IXP or cable landing),
// with a latency derived from the great-circle distance (~5 ms per 1000 km).
const HUB_NODES = INITIAL_NODES.filter(n => n.type === 'core-router' || n.type === 'gateway')

const CITY_LINKS: NetworkLink[] = INITIAL_NODES.filter(n => n.id.startsWith('city-')).map(city => {
  let best = HUB_NODES[0]
  let bestAngle = Infinity
  for (const hub of HUB_NODES) {
    const a = angularDistance(city.position, hub.position)
    if (a < bestAngle) {
      bestAngle = a
      best = hub
    }
  }
  const km = bestAngle * 6371
  const latency = Math.max(3, Math.min(90, Math.round(km / 200)))
  return { id: `l-${city.id}`, sourceId: city.id, targetId: best.id, latency, bandwidth: 120 }
})

export const INITIAL_LINKS: NetworkLink[] = [...BACKBONE_LINKS, ...CITY_LINKS]

// Node type → primary color. A restrained, cartographic palette: warm cities,
// neutral-steel backbone, teal cable landings, terracotta data centres. Shared
// by the globe markers and the UI legend.
export const NODE_COLORS: Record<NodeType, string> = {
  home: '#e6b34a',          // gold — user cities (the sources of traffic)
  'home-router': '#7fb7c9', // muted cyan (unused at global scale)
  'isp-router': '#6e93b8',  // steel (unused at global scale)
  'core-router': '#8493a8', // steel slate — backbone / IXP (neutral infrastructure)
  datacenter: '#dd6a4d',    // terracotta — data center / firewall
  server: '#57bd7d',        // green
  gateway: '#33b3a4',       // teal — submarine cable landing
}

// Human-friendly tier names for the legend.
export const NODE_TIER_LABELS: Record<NodeType, string> = {
  home: 'User City',
  'home-router': 'Home Router',
  'isp-router': 'ISP',
  'core-router': 'Backbone / IXP',
  datacenter: 'Data Center',
  server: 'Server',
  gateway: 'Cable Landing',
}

// Packet colors by transport protocol — the moving data, kept vivid and distinct.
export const PROTOCOL_COLORS: Record<'TCP' | 'UDP' | 'ICMP', string> = {
  TCP: '#4da3ff',  // azure — reliable, connection-oriented
  UDP: '#f2894a',  // orange — connectionless datagrams
  ICMP: '#4fce8d', // green — echo / ping
}
