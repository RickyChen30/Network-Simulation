/* tcp_core.h — the GlobeNet TCP stack, ported to a pure C core.
 *
 * This is a faithful port of src/engine/tcp/{seq,reasm,tcb,endpoint}.ts. It is
 * freestanding: no libc, no I/O, no threads, no malloc — just a fixed pool of
 * connection control blocks and integer arithmetic. The same source compiles to
 *   - a native object (verified by tcp_test.c with clang), and
 *   - a WebAssembly module that drops in behind GlobeNet's TcpCtx seam.
 *
 * The core never touches the network. It calls host_emit() to put a segment on
 * the wire; the host (the C test, or GlobeNet's JS glue) routes it, applies
 * loss/delay, and calls tcp_deliver() when it arrives. Time is injected: every
 * entry point takes `now` in milliseconds. Node ids and ports are integers; the
 * JS glue maps GlobeNet's string node ids to indices.
 */
#ifndef TCP_CORE_H
#define TCP_CORE_H

#include <stdint.h>

/* TCP header flags (same layout as tcp-const.ts). */
#define F_FIN 0x01
#define F_SYN 0x02
#define F_RST 0x04
#define F_PSH 0x08
#define F_ACK 0x10

/* ---- host-provided (imported in WASM, defined by the test natively) ------- */
/* Put one segment on the wire. retx != 0 marks a retransmission (RETX label). */
extern void host_emit(int32_t src_node, int32_t dst_node, int32_t src_port,
                      int32_t dst_port, uint32_t seq, uint32_t ack, int32_t flags,
                      int32_t window, int32_t payload_len, int32_t retx);

/* ---- exported core API (called by the host) ------------------------------- */
void tcp_init(void);                                  /* reset all state        */
void tcp_listen(int32_t node, int32_t port);          /* passive open           */
/* Active open: returns a connection id (>=0), or -1 if the pool is full. */
int32_t tcp_connect(int32_t cnode, int32_t snode, int32_t sport, uint32_t bytes);
void tcp_tick(uint32_t now);                          /* timers + senders       */
void tcp_deliver(uint32_t now, int32_t dst_node, int32_t src_node,
                 int32_t src_port, int32_t dst_port, uint32_t seq, uint32_t ack,
                 int32_t flags, int32_t window, int32_t payload_len);
int32_t tcp_reap(void);                               /* free done conns; ret # completed */

/* Defaults applied to passively-opened (server) connections. */
void tcp_set_default_rcv_buf(int32_t bytes);
void tcp_set_default_read_rate(double bytes_per_sec); /* <0 = instant reader     */

/* Lookup by 4-tuple (glue getTcpInfo, test finds the peer TCB). -1 if none. */
int32_t tcp_find(int32_t lnode, int32_t lport, int32_t rnode, int32_t rport);
int32_t tcp_active_conns(void);

/* Per-connection getters (cid from tcp_connect / tcp_find). */
int32_t  tcp_state(int32_t cid);          /* TcpState enum (see TS_STATE_*)     */
int32_t  tcp_done(int32_t cid);
int32_t  tcp_fin_sent(int32_t cid);
double   tcp_cwnd(int32_t cid);           /* bytes                              */
double   tcp_ssthresh(int32_t cid);       /* bytes                              */
double   tcp_srtt(int32_t cid);           /* ms                                 */
int32_t  tcp_snd_wnd(int32_t cid);        /* peer-advertised window (bytes)     */
int32_t  tcp_in_fast_recovery(int32_t cid);
int32_t  tcp_persist_armed(int32_t cid);
int32_t  tcp_loss_events(int32_t cid);
uint32_t tcp_bytes_delivered(int32_t cid);
uint32_t tcp_deliver_hash(int32_t cid);
uint32_t tcp_flight(int32_t cid);         /* bytes in flight                    */
int32_t  tcp_app_to_send(int32_t cid);
int32_t  tcp_local_port(int32_t cid);

/* Per-connection setters (glue flow-control knobs). */
void tcp_set_read_rate(int32_t cid, double bytes_per_sec); /* Infinity encoded as <0 */
void tcp_set_rcv_buf(int32_t cid, int32_t bytes);

/* States, mirroring TcpState in tcb.ts. */
enum {
  TS_CLOSED, TS_LISTEN, TS_SYN_SENT, TS_SYN_RCVD, TS_ESTABLISHED,
  TS_FIN_WAIT_1, TS_FIN_WAIT_2, TS_CLOSING, TS_TIME_WAIT, TS_CLOSE_WAIT, TS_LAST_ACK
};

/* The deterministic application byte stream (byte i is a pure fn of offset),
 * exported so the host can compute the expected hash independently. */
uint32_t tcp_gen_byte(uint32_t i);
uint32_t tcp_fold_hash(uint32_t hash, uint32_t index);
#define TCP_STREAM_HASH_INIT 2166136261u

#endif /* TCP_CORE_H */
