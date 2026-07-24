/* tcp_test.c — native verification of the C TCP core.
 *
 * Plays GlobeNet's role: host_emit() drops each segment into a simple network
 * (per-hop latency + optional random loss); the driver delivers it later via
 * tcp_deliver(). Mirrors the Milestone 2/3 checks in scripts/engine-test.mts:
 * byte-exact transfer + teardown, fast retransmit under loss, and flow control
 * + zero-window persist. Uses libc (stdio) only in this harness, never in the
 * core, so the same core compiles freestanding to WASM.
 */
#include "tcp_core.h"
#include <stdio.h>

/* ---- a tiny simulated network --------------------------------------------- */
#define NET_MAX 4096
#define HOP_MS 250.0 /* one-way delivery delay (ms) */

struct wire {
    int used;
    double deliver_at;
    int32_t src, dst, sport, dport;
    uint32_t seq, ack;
    int32_t flags, window, plen;
};
static struct wire g_wire[NET_MAX];
static double g_loss = 0.0;
static uint32_t g_seed = 0xC0FFEEu;
static double g_clock; /* ms */

static double frand(void) {
    uint32_t x = g_seed;
    x ^= x << 13; x ^= x >> 17; x ^= x << 5;
    g_seed = x;
    return (double)(x % 100000u) / 100000.0;
}

/* Called by the core to put a segment on the wire. */
void host_emit(int32_t src, int32_t dst, int32_t sport, int32_t dport,
               uint32_t seq, uint32_t ack, int32_t flags, int32_t window,
               int32_t plen, int32_t retx) {
    (void)retx;
    if (g_loss > 0 && frand() < g_loss) return; /* dropped in transit */
    for (int i = 0; i < NET_MAX; i++)
        if (!g_wire[i].used) {
            g_wire[i].used = 1;
            g_wire[i].deliver_at = g_clock + HOP_MS;
            g_wire[i].src = src; g_wire[i].dst = dst;
            g_wire[i].sport = sport; g_wire[i].dport = dport;
            g_wire[i].seq = seq; g_wire[i].ack = ack;
            g_wire[i].flags = flags; g_wire[i].window = window; g_wire[i].plen = plen;
            return;
        }
}

static void net_deliver_due(void) {
    for (int i = 0; i < NET_MAX; i++)
        if (g_wire[i].used && g_wire[i].deliver_at <= g_clock) {
            g_wire[i].used = 0;
            tcp_deliver((uint32_t)g_clock, g_wire[i].dst, g_wire[i].src, g_wire[i].sport,
                        g_wire[i].dport, g_wire[i].seq, g_wire[i].ack, g_wire[i].flags,
                        g_wire[i].window, g_wire[i].plen);
        }
}

static void net_reset(double loss, uint32_t seed) {
    for (int i = 0; i < NET_MAX; i++) g_wire[i].used = 0;
    g_loss = loss;
    g_clock = 0;
    g_seed = seed;
}

static uint32_t expected_hash(uint32_t bytes) {
    uint32_t h = TCP_STREAM_HASH_INIT;
    for (uint32_t i = 0; i < bytes; i++) h = tcp_fold_hash(h, i);
    return h;
}

/* ---- scenarios ------------------------------------------------------------ */
static const int CLIENT = 0, SERVER = 1;
static const double DT = 1000.0 / 60.0;

/* Run until the client connection is done or `secs` elapse. `hook` (if set) is
 * called each tick with the current client/server cids for scenario tweaks. */
static int run_until_done(int ccid, int scid_hint, double secs, void (*hook)(int, int, double)) {
    int frames = (int)(secs * 1000.0 / DT);
    for (int f = 0; f < frames; f++) {
        g_clock += DT;
        net_deliver_due();
        tcp_tick((uint32_t)g_clock);
        int scid = tcp_find(SERVER, 443, CLIENT, tcp_local_port(ccid));
        if (hook) hook(ccid, scid, g_clock);
        (void)scid_hint;
        if (tcp_done(ccid)) return 1;
    }
    return 0;
}

static int test_basic(void) {
    const uint32_t XFER = 48 * 1024;
    tcp_init();
    net_reset(0.0, 1u);
    tcp_listen(SERVER, 443);
    int c = tcp_connect(CLIENT, SERVER, 443, XFER);
    run_until_done(c, -1, 60, 0);
    int s = tcp_find(SERVER, 443, CLIENT, tcp_local_port(c));
    int ok = s >= 0 && tcp_bytes_delivered(s) == XFER &&
             tcp_deliver_hash(s) == expected_hash(XFER) &&
             tcp_state(c) == TS_CLOSED && tcp_state(s) == TS_CLOSED;
    printf("basic transfer : %s  (%u/%u B, hash %s, client %d, server %d)\n",
           ok ? "PASS" : "FAIL", s >= 0 ? tcp_bytes_delivered(s) : 0, XFER,
           (s >= 0 && tcp_deliver_hash(s) == expected_hash(XFER)) ? "match" : "MISMATCH",
           tcp_state(c), tcp_state(s));
    return ok;
}

static int g_saw_fast_retx;
static void fr_hook(int c, int s, double now) {
    (void)s; (void)now;
    if (tcp_in_fast_recovery(c)) g_saw_fast_retx = 1;
}
static int fr_once(uint32_t XFER, double loss, uint32_t seed) {
    tcp_init();
    net_reset(loss, seed);
    tcp_listen(SERVER, 443);
    int c = tcp_connect(CLIENT, SERVER, 443, XFER);
    g_saw_fast_retx = 0;
    run_until_done(c, -1, 240, fr_hook);
    int s = tcp_find(SERVER, 443, CLIENT, tcp_local_port(c));
    int ok = s >= 0 && tcp_bytes_delivered(s) == XFER && tcp_deliver_hash(s) == expected_hash(XFER);
    if (!ok)
        printf("  [debug] seed=%u loss=%.2f: delivered=%u/%u clientState=%d clientDone=%d cwnd=%.0f flight=%u\n",
               seed, loss, s >= 0 ? tcp_bytes_delivered(s) : 0, XFER, tcp_state(c), tcp_done(c),
               tcp_cwnd(c), tcp_flight(c));
    return ok;
}
static int test_fast_retransmit(void) {
    /* Stress across loss patterns and rates: every one must arrive byte-exact,
     * and fast recovery must be exercised somewhere. */
    int ok = 1, saw_fr = 0;
    /* 12 loss patterns at 4% — the envelope the TS stack is verified against. */
    for (uint32_t seed = 1; seed <= 12; seed++) { ok &= fr_once(64 * 1024, 0.04, seed * 2654435761u + 11u); saw_fr |= g_saw_fast_retx; }
    ok &= saw_fr;
    printf("fast retransmit: %s  (12 loss patterns @4%% byte-exact, fast-recovery seen %d)\n",
           ok ? "PASS" : "FAIL", saw_fr);
    return ok;
}

static int g_saw_zero_win, g_saw_persist, g_stalled, g_resumed;
static void fc_hook(int c, int s, double now) {
    if (s >= 0 && !g_stalled && tcp_bytes_delivered(s) > 2048) { tcp_set_read_rate(s, 0); g_stalled = 1; }
    if (g_stalled && !g_resumed && now > 12000 && s >= 0) { tcp_set_read_rate(s, -1); g_resumed = 1; }
    if (tcp_snd_wnd(c) == 0) g_saw_zero_win = 1;
    if (tcp_persist_armed(c)) g_saw_persist = 1;
}
static int test_flow_control(void) {
    const uint32_t XFER = 24 * 1024;
    tcp_init();
    net_reset(0.0, 1u);
    tcp_set_default_rcv_buf(4096);
    tcp_listen(SERVER, 443);
    int c = tcp_connect(CLIENT, SERVER, 443, XFER);
    g_saw_zero_win = g_saw_persist = g_stalled = g_resumed = 0;
    run_until_done(c, -1, 90, fc_hook);
    int s = tcp_find(SERVER, 443, CLIENT, tcp_local_port(c));
    int ok = g_saw_zero_win && g_saw_persist && s >= 0 &&
             tcp_bytes_delivered(s) == XFER && tcp_deliver_hash(s) == expected_hash(XFER) &&
             tcp_state(c) == TS_CLOSED;
    printf("flow control   : %s  (zero-win %d, persist %d, %u/%u B, client %d)\n",
           ok ? "PASS" : "FAIL", g_saw_zero_win, g_saw_persist,
           s >= 0 ? tcp_bytes_delivered(s) : 0, XFER, tcp_state(c));
    return ok;
}

int main(void) {
    printf("=== C TCP core — native verification ===\n");
    int ok = 1;
    ok &= test_basic();
    ok &= test_fast_retransmit();
    ok &= test_flow_control();
    printf(ok ? "\nALL C CORE CHECKS PASSED\n" : "\nSOME CHECKS FAILED\n");
    return ok ? 0 : 1;
}
