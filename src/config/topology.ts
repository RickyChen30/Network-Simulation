import type { NetworkNode, NetworkLink, NodeType } from '../types/network'
import { latLongToVec3 } from './globe'

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
  // --- User cities (traffic origins) ---
  { id: 'home-lon', type: 'home', lat: 51.6, long: -0.2, label: 'London User' },
  { id: 'home-sao', type: 'home', lat: -23.6, long: -46.7, label: 'Sao Paulo User' },
  { id: 'home-mum', type: 'home', lat: 19.0, long: 72.9, label: 'Mumbai User' },
  { id: 'home-syd', type: 'home', lat: -33.9, long: 151.2, label: 'Sydney User' },

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
  { id: 'dc-ash', type: 'datacenter', lat: 39.0, long: -77.5, label: 'Ashburn DC', sub: 'us-east' },
  { id: 'dc-fra', type: 'datacenter', lat: 50.0, long: 8.6, label: 'Frankfurt DC', sub: 'eu-central' },
  { id: 'dc-sin', type: 'datacenter', lat: 1.3, long: 103.7, label: 'Singapore DC', sub: 'ap-southeast' },
  { id: 'dc-tyo', type: 'datacenter', lat: 35.6, long: 139.8, label: 'Tokyo DC', sub: 'ap-northeast' },

  // --- Servers inside the data centers ---
  { id: 'srv-ash1', type: 'server', lat: 39.05, long: -77.55, label: 'us-east-web' },
  { id: 'srv-ash2', type: 'server', lat: 38.95, long: -77.45, label: 'us-east-api' },
  { id: 'srv-fra1', type: 'server', lat: 50.05, long: 8.5, label: 'eu-web' },
  { id: 'srv-sin1', type: 'server', lat: 1.25, long: 103.65, label: 'ap-web' },
  { id: 'srv-tyo1', type: 'server', lat: 35.55, long: 139.9, label: 'ap-ne-web' },
]

export const INITIAL_NODES: NetworkNode[] = NODE_DEFS.map(d => ({
  id: d.id,
  type: d.type,
  label: d.label,
  subLabel: d.sub,
  position: latLongToVec3(d.lat, d.long),
  active: true,
}))

// Latency is one-way milliseconds, roughly proportional to real distance, so
// intercontinental hops dominate the round-trip time.
export const INITIAL_LINKS: NetworkLink[] = [
  // Users → regional backbone
  { id: 'l-hlon', sourceId: 'home-lon', targetId: 'core-lon', latency: 3, bandwidth: 100 },
  { id: 'l-hsao', sourceId: 'home-sao', targetId: 'core-sao', latency: 3, bandwidth: 100 },
  { id: 'l-hmum', sourceId: 'home-mum', targetId: 'core-bom', latency: 3, bandwidth: 100 },
  { id: 'l-hsyd', sourceId: 'home-syd', targetId: 'core-syd', latency: 3, bandwidth: 100 },

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

// Node type → primary color, shared by rendering and the UI legend.
export const NODE_COLORS: Record<NodeType, string> = {
  home: '#fbbf24',          // amber
  'home-router': '#22d3ee', // cyan (unused at global scale)
  'isp-router': '#38bdf8',  // sky (unused at global scale)
  'core-router': '#a855f7', // purple — backbone / IXP
  datacenter: '#fb7185',    // rose — data center / firewall
  server: '#34d399',        // emerald
  gateway: '#2dd4bf',       // teal — submarine cable landing
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

// Packet colors by kind.
export const PACKET_COLORS: Record<string, string> = {
  request: '#67e8f9',  // bright cyan — heading to the server
  response: '#fde047', // warm yellow — data coming back home
}
