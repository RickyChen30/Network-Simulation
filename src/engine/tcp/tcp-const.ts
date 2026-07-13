// Tuning constants for the real per-endpoint TCP stack (see
// docs/tcp-endpoints-plan.md). Kept apart from the legacy flow-model TCP
// constants in simulation.ts so the two can coexist during migration.

// TCP header flag bits (same layout as the standalone reference header).
export const F_FIN = 0x01
export const F_SYN = 0x02
export const F_RST = 0x04
export const F_PSH = 0x08
export const F_ACK = 0x10

// Bytes of application data per full-size segment.
export const MSS = 1024

// Congestion control (in BYTES, unlike the old segment-counted model).
export const INIT_CWND = MSS // every connection starts probing from one segment
export const INIT_SSTHRESH = 8 * MSS // hand-off point from slow start to CA

// Flow control: per-connection socket buffers.
export const SND_BUF = 64 * 1024
export const RCV_BUF = 64 * 1024

// Retransmission timeout bounds and initial value (ms of sim time).
// Simulated per-hop travel is 0.14–0.55 s, so RTTs run to several seconds — the
// initial RTO is generous and then RTT estimation (below) adapts it per path.
export const RTO_MIN = 400
export const RTO_MAX = 60_000
export const RTO_INIT = 3000

// Karn/Jacobson RTT estimator gains.
export const RTT_ALPHA = 0.125 // srtt   = (1-a)·srtt + a·sample
export const RTT_BETA = 0.25 // rttvar = (1-b)·rttvar + b·|srtt-sample|
export const RTO_K = 4 // rto = srtt + K·rttvar

// Delayed-ACK hold time and max segments before forcing an ACK.
export const DELAYED_ACK_MS = 40
export const DELAYED_ACK_SEGS = 2

// Teardown: TIME_WAIT lasts 2·MSL. Short so demos finish quickly.
export const MSL_MS = 500

// Give up on a segment after this many retransmissions (connection reset).
export const MAX_RETX = 8

// Ephemeral (client) port range for active opens.
export const EPHEMERAL_BASE = 49152
export const EPHEMERAL_SPAN = 16384

// Well-known server ports.
export const PORT_HTTP = 80
export const PORT_HTTPS = 443
