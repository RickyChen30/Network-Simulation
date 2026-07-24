/* tcp_core.c — GlobeNet TCP, pure C core. See tcp_core.h.
 * A faithful port of src/engine/tcp/{seq,reasm,tcb,endpoint}.ts. Freestanding:
 * no libc, no I/O, no malloc — fixed pools and integer/double arithmetic only.
 */
#include "tcp_core.h"

/* ---- tuning (mirror tcp-const.ts) ----------------------------------------- */
#define MSS 1024
#define INIT_CWND (double)MSS
#define INIT_SSTHRESH (double)(8 * MSS)
#define RCV_BUF (64 * 1024)
#define RTO_MIN 400.0
#define RTO_MAX 60000.0
#define RTO_INIT 3000.0
#define RTT_ALPHA 0.125
#define RTT_BETA 0.25
#define RTO_K 4.0
#define DELAYED_ACK_MS 40
#define DELAYED_ACK_SEGS 2
#define MSL_MS 500
#define MAX_RETX 8
#define MAX_SEGS_PER_TICK 4

#define MAX_CONNS 128
#define MAX_LISTENERS 64
#define MAX_RANGES 32
#define MAX_INFLIGHT 160

/* ---- 32-bit serial-number arithmetic (seq.ts) ----------------------------- */
static int seq_lt(uint32_t a, uint32_t b) { return (int32_t)(a - b) < 0; }
static int seq_leq(uint32_t a, uint32_t b) { return (int32_t)(a - b) <= 0; }
static int seq_gt(uint32_t a, uint32_t b) { return (int32_t)(a - b) > 0; }
static int seq_geq(uint32_t a, uint32_t b) { return (int32_t)(a - b) >= 0; }
static int32_t seq_diff(uint32_t a, uint32_t b) { return (int32_t)(a - b); }
static uint32_t seq_add(uint32_t a, uint32_t n) { return a + n; }

/* ---- deterministic app stream + hash (tcb.ts) ----------------------------- */
uint32_t tcp_gen_byte(uint32_t i) { return ((i * 2654435761u) >> 24) & 0xff; }
uint32_t tcp_fold_hash(uint32_t hash, uint32_t index) {
    return (uint32_t)((hash * 31u) + tcp_gen_byte(index));
}

/* ---- tiny PRNG for ISS (freestanding, no rand()) -------------------------- */
static uint32_t g_rng = 0x9e3779b9u;
static uint32_t rng_next(void) {
    uint32_t x = g_rng;
    x ^= x << 13; x ^= x >> 17; x ^= x << 5;
    return (g_rng = x);
}

/* ---- reassembly (reasm.ts) — inlined per TCB ------------------------------ */
struct range { uint32_t start, end; };

/* ---- inflight retransmit entry -------------------------------------------- */
struct inflt { uint32_t seq, end; uint32_t sent_at; int32_t retx; int used; };

/* ---- Transmission Control Block (tcb.ts) ---------------------------------- */
struct tcb {
    int used, done;
    int32_t local_node, local_port, remote_node, remote_port;
    int state;

    uint32_t iss, snd_una, snd_nxt, snd_max, write_seq;
    int32_t snd_wnd;

    uint32_t irs, rcv_nxt, read_seq;
    int32_t rcv_buf;
    struct range ranges[MAX_RANGES];
    int nranges;

    double cwnd, ssthresh;
    int dup_acks, in_fast_recovery;
    uint32_t recover;

    double srtt, rttvar, rto;
    int rtt_timing, rtt_retx;
    uint32_t rtt_seq;
    double rtt_start;

    double rto_deadline, del_ack_deadline, time_wait_deadline, persist_deadline, persist_backoff;
    int ack_pending, unacked_segs;

    int read_instant;
    double read_rate, last_read;

    struct inflt inflight[MAX_INFLIGHT];

    int32_t app_to_send;
    int syn_sent, fin_requested, fin_sent;
    uint32_t fin_seq;
    int retx_count;

    uint32_t bytes_delivered, deliver_hash;
    int loss_events, rtt_sampled;
};

static struct tcb g_conns[MAX_CONNS];
static struct { int32_t node, port; } g_listeners[MAX_LISTENERS];
static int g_nlisteners;
static int32_t g_default_rcv_buf = RCV_BUF;
static int g_default_read_instant = 1;
static double g_default_read_rate = 0;
static int32_t g_completed;
static double g_now; /* injected clock, ms */

/* ======================================================================== */

void tcp_init(void) {
    for (int i = 0; i < MAX_CONNS; i++) g_conns[i].used = 0;
    g_nlisteners = 0;
    g_default_rcv_buf = RCV_BUF;
    g_default_read_instant = 1;
    g_default_read_rate = 0;
    g_completed = 0;
    g_now = 0;
    g_rng = 0x9e3779b9u;
}

void tcp_set_default_rcv_buf(int32_t bytes) { g_default_rcv_buf = bytes; }
void tcp_set_default_read_rate(double r) {
    if (r < 0) { g_default_read_instant = 1; }
    else { g_default_read_instant = 0; g_default_read_rate = r; }
}

static int alloc_tcb(void) {
    for (int i = 0; i < MAX_CONNS; i++) if (!g_conns[i].used) return i;
    return -1;
}

static void tcb_zero(struct tcb *t) {
    uint32_t iss = (rng_next() & 0x7fffffffu);
    /* zero everything, then set the createTcb() defaults */
    for (unsigned k = 0; k < sizeof(*t); k++) ((char *)t)[k] = 0;
    t->used = 1;
    t->iss = iss;
    t->snd_una = t->snd_nxt = t->snd_max = t->write_seq = iss;
    t->snd_wnd = (int32_t)INIT_CWND;
    t->rcv_buf = RCV_BUF;
    t->cwnd = INIT_CWND;
    t->ssthresh = INIT_SSTHRESH;
    t->recover = iss;
    t->rto = RTO_INIT;
    t->persist_backoff = RTO_INIT;
    t->read_instant = 1;
    t->deliver_hash = TCP_STREAM_HASH_INIT;
}

/* ---- reassembly ops ------------------------------------------------------- */
static int ranges_touch(struct range *a, struct range *b) {
    return seq_leq(a->start, b->end) && seq_leq(b->start, a->end);
}
static void reasm_insert(struct tcb *t, uint32_t seq, uint32_t len) {
    if ((int32_t)len <= 0) return;
    if (t->nranges >= MAX_RANGES) return;
    t->ranges[t->nranges].start = seq;
    t->ranges[t->nranges].end = seq + len;
    t->nranges++;
    /* brute-force coalesce (n tiny) */
    int merged = 1;
    while (merged) {
        merged = 0;
        for (int i = 0; i < t->nranges && !merged; i++)
            for (int j = i + 1; j < t->nranges; j++)
                if (ranges_touch(&t->ranges[i], &t->ranges[j])) {
                    if (seq_lt(t->ranges[j].start, t->ranges[i].start)) t->ranges[i].start = t->ranges[j].start;
                    if (seq_gt(t->ranges[j].end, t->ranges[i].end)) t->ranges[i].end = t->ranges[j].end;
                    t->ranges[j] = t->ranges[t->nranges - 1];
                    t->nranges--;
                    merged = 1;
                    break;
                }
    }
}
static uint32_t reasm_advance(struct tcb *t, uint32_t rcv_nxt) {
    uint32_t nxt = rcv_nxt;
    int changed = 1;
    while (changed) {
        changed = 0;
        for (int i = 0; i < t->nranges; i++) {
            struct range *r = &t->ranges[i];
            if (seq_leq(r->end, nxt)) {
                *r = t->ranges[--t->nranges]; changed = 1; break; /* fully delivered */
            } else if (seq_leq(r->start, nxt)) {
                if (seq_gt(r->end, nxt)) nxt = r->end;
                *r = t->ranges[--t->nranges]; changed = 1; break;
            }
        }
    }
    return nxt;
}

/* ---- inflight ops --------------------------------------------------------- */
static void inflt_set(struct tcb *t, uint32_t seq, uint32_t end, uint32_t now) {
    for (int i = 0; i < MAX_INFLIGHT; i++)
        if (t->inflight[i].used && t->inflight[i].seq == seq) {
            t->inflight[i].end = end; t->inflight[i].sent_at = now; t->inflight[i].retx = 0; return;
        }
    for (int i = 0; i < MAX_INFLIGHT; i++)
        if (!t->inflight[i].used) {
            t->inflight[i].used = 1; t->inflight[i].seq = seq; t->inflight[i].end = end;
            t->inflight[i].sent_at = now; t->inflight[i].retx = 0; return;
        }
}
static struct inflt *inflt_get(struct tcb *t, uint32_t seq) {
    for (int i = 0; i < MAX_INFLIGHT; i++)
        if (t->inflight[i].used && t->inflight[i].seq == seq) return &t->inflight[i];
    return 0;
}
static void inflt_drop_acked(struct tcb *t, uint32_t ack) {
    for (int i = 0; i < MAX_INFLIGHT; i++)
        if (t->inflight[i].used && seq_leq(t->inflight[i].end, ack)) t->inflight[i].used = 0;
}
static void inflt_clear(struct tcb *t) {
    for (int i = 0; i < MAX_INFLIGHT; i++) t->inflight[i].used = 0;
}

/* ---- helpers -------------------------------------------------------------- */
static uint32_t flight_size(struct tcb *t) { return (uint32_t)seq_diff(t->snd_nxt, t->snd_una); }

static int32_t recv_window(struct tcb *t) {
    int32_t buffered = seq_diff(t->rcv_nxt, t->read_seq);
    int32_t w = t->rcv_buf - buffered;
    if (w < 0) w = 0;
    if (w > 65535) w = 65535;
    return w;
}

static void tsend(struct tcb *t, int32_t flags, uint32_t seq, int32_t plen, int retx) {
    host_emit(t->local_node, t->remote_node, t->local_port, t->remote_port,
              seq, t->rcv_nxt, flags, recv_window(t), plen, retx);
    if (flags & F_ACK) { t->ack_pending = 0; t->unacked_segs = 0; t->del_ack_deadline = 0; }
}
static void send_ack_now(struct tcb *t) { tsend(t, F_ACK, t->snd_nxt, 0, 0); }

static void schedule_delayed_ack(struct tcb *t) {
    t->unacked_segs++;
    if (t->unacked_segs >= DELAYED_ACK_SEGS) { send_ack_now(t); return; }
    t->ack_pending = 1;
    if (t->del_ack_deadline == 0) t->del_ack_deadline = g_now + DELAYED_ACK_MS;
}
static void track(struct tcb *t, uint32_t start, uint32_t end, int is_new) {
    inflt_set(t, start, end, (uint32_t)g_now);
    if (is_new && !t->rtt_timing) {
        t->rtt_timing = 1; t->rtt_seq = start; t->rtt_start = g_now; t->rtt_retx = 0;
    }
}
static void arm_rto(struct tcb *t) { if (t->rto_deadline == 0) t->rto_deadline = g_now + t->rto; }

static double dmax(double a, double b) { return a > b ? a : b; }
static double dmin(double a, double b) { return a < b ? a : b; }

/* ---- listeners ------------------------------------------------------------ */
void tcp_listen(int32_t node, int32_t port) {
    if (g_nlisteners < MAX_LISTENERS) { g_listeners[g_nlisteners].node = node; g_listeners[g_nlisteners].port = port; g_nlisteners++; }
}
static int is_listening(int32_t node, int32_t port) {
    for (int i = 0; i < g_nlisteners; i++) if (g_listeners[i].node == node && g_listeners[i].port == port) return 1;
    return 0;
}

int32_t tcp_find(int32_t lnode, int32_t lport, int32_t rnode, int32_t rport) {
    for (int i = 0; i < MAX_CONNS; i++) {
        struct tcb *t = &g_conns[i];
        if (t->used && t->local_node == lnode && t->local_port == lport &&
            t->remote_node == rnode && t->remote_port == rport) return i;
    }
    return -1;
}

/* ---- active / passive open ------------------------------------------------ */
static int32_t g_ephemeral = 49152;
int32_t tcp_connect(int32_t cnode, int32_t snode, int32_t sport, uint32_t bytes) {
    int cid = alloc_tcb();
    if (cid < 0) return -1;
    struct tcb *t = &g_conns[cid];
    tcb_zero(t);
    t->local_node = cnode; t->local_port = g_ephemeral++;
    if (g_ephemeral >= 65535) g_ephemeral = 49152;
    t->remote_node = snode; t->remote_port = sport;
    t->state = TS_SYN_SENT;
    /* stream: [iss]=SYN, [iss+1 .. iss+1+bytes)=data, [iss+1+bytes]=FIN */
    t->write_seq = seq_add(t->iss, 1 + bytes);
    t->fin_requested = 1;
    t->fin_seq = seq_add(t->iss, 1 + bytes);
    t->app_to_send = (int32_t)bytes;
    return cid;
}

static int passive_open(int32_t dnode, int32_t src, int32_t sport, int32_t dport,
                        uint32_t seq, int32_t window) {
    int cid = alloc_tcb();
    if (cid < 0) return -1;
    struct tcb *t = &g_conns[cid];
    tcb_zero(t);
    t->local_node = dnode; t->local_port = dport;
    t->remote_node = src; t->remote_port = sport;
    t->state = TS_SYN_RCVD;
    t->irs = seq;
    t->rcv_nxt = seq_add(t->irs, 1);
    t->read_seq = t->rcv_nxt;
    t->snd_wnd = window;
    t->rcv_buf = g_default_rcv_buf;
    t->read_instant = g_default_read_instant;
    t->read_rate = g_default_read_rate;
    tsend(t, F_SYN | F_ACK, t->iss, 0, 0);
    t->snd_nxt = seq_add(t->iss, 1);
    t->snd_max = t->snd_nxt;
    t->syn_sent = 1;
    track(t, t->iss, seq_add(t->iss, 1), 1);
    arm_rto(t);
    return cid;
}

/* ---- receive path --------------------------------------------------------- */
static int recv_data(struct tcb *t, uint32_t seq, int32_t len) {
    if (seq_leq(seq_add(seq, len), t->rcv_nxt)) return 0;         /* pure dup */
    uint32_t limit = seq_add(t->read_seq, t->rcv_buf);
    if (seq_geq(seq, limit)) return 0;                            /* beyond window */
    uint32_t end = seq_add(seq, len);
    if (seq_gt(end, limit)) end = limit;
    int32_t clamped = seq_diff(end, seq);
    if (clamped <= 0) return 0;
    reasm_insert(t, seq, clamped);
    uint32_t before = t->rcv_nxt;
    uint32_t after = reasm_advance(t, before);
    if (seq_gt(after, before)) {
        int32_t delivered = seq_diff(after, before);
        uint32_t data_start = seq_add(t->irs, 1);
        int32_t start_idx = seq_diff(before, data_start);
        for (int32_t k = 0; k < delivered; k++)
            t->deliver_hash = tcp_fold_hash(t->deliver_hash, (uint32_t)(start_idx + k));
        t->bytes_delivered += (uint32_t)delivered;
        t->rcv_nxt = after;
        return 1;
    }
    return 0;
}

static void recv_fin(struct tcb *t) {
    t->rcv_nxt = seq_add(t->rcv_nxt, 1);
    switch (t->state) {
        case TS_ESTABLISHED:
            t->state = TS_CLOSE_WAIT; t->fin_requested = 1; t->fin_seq = t->snd_nxt; break;
        case TS_FIN_WAIT_1: t->state = TS_CLOSING; break;
        case TS_FIN_WAIT_2: t->state = TS_TIME_WAIT; t->time_wait_deadline = g_now + 2 * MSL_MS; break;
    }
}

static void resend_oldest(struct tcb *t) {
    if (t->fin_sent && seq_geq(t->snd_una, t->fin_seq)) {
        tsend(t, F_FIN | F_ACK, t->fin_seq, 0, 1);
    } else {
        uint32_t data_end = t->fin_requested ? t->fin_seq : t->write_seq;
        int32_t len = seq_diff(data_end, t->snd_una);
        if (len > MSS) len = MSS;
        if (len <= 0) return;
        tsend(t, F_PSH | F_ACK, t->snd_una, len, 1);
    }
    struct inflt *seg = inflt_get(t, t->snd_una);
    if (seg) { seg->sent_at = (uint32_t)g_now; seg->retx++; }
    t->rtt_retx = 1;
    t->rto_deadline = g_now + t->rto;
}

static void process_ack(struct tcb *t, uint32_t ack, int32_t prev_wnd, int has_data) {
    if (seq_gt(ack, t->snd_una) && seq_leq(ack, t->snd_max)) {
        uint32_t old_una = t->snd_una;
        if (t->rtt_timing && !t->rtt_retx && seq_gt(ack, t->rtt_seq)) {
            double r = g_now - t->rtt_start;
            if (t->srtt == 0) { t->srtt = r; t->rttvar = r / 2; }
            else {
                double d = t->srtt - r; if (d < 0) d = -d;
                t->rttvar = (1 - RTT_BETA) * t->rttvar + RTT_BETA * d;
                t->srtt = (1 - RTT_ALPHA) * t->srtt + RTT_ALPHA * r;
            }
            t->rto = dmin(RTO_MAX, dmax(RTO_MIN, t->srtt + RTO_K * t->rttvar));
            t->rtt_timing = 0;
        }
        t->snd_una = ack;
        if (seq_lt(t->snd_nxt, t->snd_una)) t->snd_nxt = t->snd_una;
        inflt_drop_acked(t, ack);
        t->retx_count = 0;

        if (t->in_fast_recovery) {
            if (seq_geq(ack, t->recover)) {
                t->cwnd = t->ssthresh; t->in_fast_recovery = 0; t->dup_acks = 0;
            } else {
                resend_oldest(t);
                int32_t acked = seq_diff(ack, old_una);
                t->cwnd = dmax((double)MSS, t->cwnd - acked + MSS);
            }
        } else {
            if (t->cwnd < t->ssthresh) t->cwnd += MSS;
            else { double inc = (double)MSS * MSS / t->cwnd; if (inc < 1) inc = 1; t->cwnd += inc; }
            t->dup_acks = 0;
        }
        t->rto_deadline = (t->snd_una == t->snd_nxt) ? 0 : g_now + t->rto;
    } else if (ack == t->snd_una && !has_data && t->snd_wnd == prev_wnd &&
               t->snd_wnd > 0 && seq_gt(t->snd_nxt, t->snd_una)) {
        t->dup_acks++;
        if (!t->in_fast_recovery && t->dup_acks == 3) {
            t->ssthresh = dmax((double)(flight_size(t) / 2), (double)(2 * MSS));
            t->loss_events++;
            t->recover = t->snd_max;
            resend_oldest(t);
            t->cwnd = t->ssthresh + 3 * MSS;
            t->in_fast_recovery = 1;
        } else if (t->in_fast_recovery) {
            t->cwnd += MSS;
        }
    }
}

static void check_fin_acked(struct tcb *t) {
    if (!t->fin_sent) return;
    if (!seq_geq(t->snd_una, seq_add(t->fin_seq, 1))) return;
    switch (t->state) {
        case TS_FIN_WAIT_1: t->state = TS_FIN_WAIT_2; break;
        case TS_CLOSING: t->state = TS_TIME_WAIT; t->time_wait_deadline = g_now + 2 * MSL_MS; break;
        case TS_LAST_ACK: t->state = TS_CLOSED; t->done = 1; break;
    }
}

static void on_segment(struct tcb *t, uint32_t seq, uint32_t ack, int32_t flags,
                       int32_t window, int32_t len) {
    if (flags & F_RST) { t->done = 1; return; }
    int32_t prev_wnd = t->snd_wnd;
    t->snd_wnd = window;

    if (flags & F_ACK) process_ack(t, ack, prev_wnd, len > 0);
    if (t->snd_wnd > 0) t->persist_deadline = 0;

    if (t->state == TS_SYN_SENT) {
        if ((flags & F_SYN) && (flags & F_ACK)) {
            t->irs = seq;
            t->rcv_nxt = seq_add(seq, 1);
            t->read_seq = t->rcv_nxt;
            t->state = TS_ESTABLISHED;
            send_ack_now(t);
        }
        return;
    }
    if (t->state == TS_SYN_RCVD && seq_geq(t->snd_una, seq_add(t->iss, 1))) t->state = TS_ESTABLISHED;

    int immediate = 0, delayed = 0;
    if (len > 0) {
        if (recv_data(t, seq, len)) delayed = 1; else immediate = 1;
        if (t->nranges > 0) immediate = 1;
    }
    if (flags & F_FIN) {
        if (seq == t->rcv_nxt) recv_fin(t);
        immediate = 1;
    }
    if (immediate) send_ack_now(t);
    else if (delayed) schedule_delayed_ack(t);

    check_fin_acked(t);
}

void tcp_deliver(uint32_t now, int32_t dst, int32_t src, int32_t sport, int32_t dport,
                 uint32_t seq, uint32_t ack, int32_t flags, int32_t window, int32_t plen) {
    g_now = now;
    int cid = tcp_find(dst, dport, src, sport);
    if (cid < 0) {
        if ((flags & F_SYN) && !(flags & F_ACK) && is_listening(dst, dport))
            passive_open(dst, src, sport, dport, seq, window);
        return;
    }
    on_segment(&g_conns[cid], seq, ack, flags, window, plen);
}

/* ---- sender + timers ------------------------------------------------------ */
static void drain_app(struct tcb *t) {
    if (t->read_instant) { t->read_seq = t->rcv_nxt; return; }
    if (t->last_read == 0) t->last_read = g_now;
    double dt = g_now - t->last_read;
    if (dt <= 0) return;
    t->last_read = g_now;
    int32_t free_before = recv_window(t);
    int32_t can_read = (int32_t)((t->read_rate * dt) / 1000);
    int32_t buffered = seq_diff(t->rcv_nxt, t->read_seq);
    int32_t n = can_read < buffered ? can_read : buffered;
    if (n > 0) t->read_seq = seq_add(t->read_seq, n);
    if (free_before < MSS && recv_window(t) >= MSS && t->state != TS_CLOSED) send_ack_now(t);
}

static void on_rto(struct tcb *t) {
    if (seq_geq(t->snd_una, t->snd_nxt)) { t->rto_deadline = 0; return; }
    t->retx_count++;
    if (t->retx_count > MAX_RETX) { t->done = 1; return; }
    t->ssthresh = dmax((double)(flight_size(t) / 2), (double)(2 * MSS));
    t->cwnd = MSS;
    t->loss_events++;
    t->in_fast_recovery = 0;
    t->dup_acks = 0;
    t->rtt_timing = 0;
    t->rto = dmin(t->rto * 2, RTO_MAX);
    t->rto_deadline = g_now + t->rto;

    if (t->snd_una == t->iss) {
        int32_t f = (t->state == TS_SYN_RCVD) ? (F_SYN | F_ACK) : F_SYN;
        tsend(t, f, t->iss, 0, 1);
        struct inflt *seg = inflt_get(t, t->iss);
        if (seg) { seg->sent_at = (uint32_t)g_now; seg->retx++; }
        return;
    }
    /* Go-Back-N: rewind and let the sender resend from the oldest unacked byte. */
    inflt_clear(t);
    t->snd_nxt = t->snd_una;
    if (t->fin_sent) t->fin_sent = 0;
}

static void send_probe(struct tcb *t) {
    uint32_t data_end = t->fin_requested ? t->fin_seq : t->write_seq;
    if (seq_gt(data_end, t->snd_nxt)) {
        uint32_t end = seq_add(t->snd_nxt, 1);
        int is_new = seq_geq(t->snd_nxt, t->snd_max);
        tsend(t, F_PSH | F_ACK, t->snd_nxt, 1, !is_new);
        track(t, t->snd_nxt, end, is_new);
        t->snd_nxt = end;
        if (is_new) t->snd_max = end;
        arm_rto(t);
    }
    t->persist_backoff = dmin(RTO_MAX, t->persist_backoff * 2);
    t->persist_deadline = g_now + t->persist_backoff;
}

static void service_timers(struct tcb *t) {
    if (t->rto_deadline && g_now >= t->rto_deadline) on_rto(t);
    if (t->ack_pending && t->del_ack_deadline && g_now >= t->del_ack_deadline) send_ack_now(t);
    if (t->persist_deadline && g_now >= t->persist_deadline) send_probe(t);
    if (t->state == TS_TIME_WAIT && t->time_wait_deadline && g_now >= t->time_wait_deadline) {
        t->state = TS_CLOSED; t->done = 1;
    }
}

static void send_segments(struct tcb *t) {
    if (t->state == TS_SYN_SENT && !t->syn_sent) {
        tsend(t, F_SYN, t->iss, 0, 0);
        t->snd_nxt = seq_add(t->iss, 1);
        t->snd_max = t->snd_nxt;
        t->syn_sent = 1;
        track(t, t->iss, seq_add(t->iss, 1), 1);
        arm_rto(t);
        return;
    }
    if (t->state != TS_ESTABLISHED && t->state != TS_FIN_WAIT_1 &&
        t->state != TS_CLOSE_WAIT && t->state != TS_LAST_ACK) return;

    double win = dmin(t->cwnd, (double)t->snd_wnd);
    int sent_this_tick = 0;
    for (;;) {
        int32_t flight = (int32_t)flight_size(t);
        if (flight >= win) break;
        int32_t can = (int32_t)win - flight;
        uint32_t data_end = t->fin_requested ? t->fin_seq : t->write_seq;
        int32_t avail = seq_diff(data_end, t->snd_nxt);

        if (avail > 0) {
            if (sent_this_tick >= MAX_SEGS_PER_TICK) break;
            int32_t len = avail < MSS ? avail : MSS;
            if (len > can) len = can;
            if (len <= 0) break;
            uint32_t end = seq_add(t->snd_nxt, len);
            int is_new = seq_geq(t->snd_nxt, t->snd_max);
            tsend(t, F_PSH | F_ACK, t->snd_nxt, len, !is_new);
            track(t, t->snd_nxt, end, is_new);
            t->snd_nxt = end;
            if (is_new) t->snd_max = end;
            arm_rto(t);
            sent_this_tick++;
            continue;
        }
        if (t->fin_requested && !t->fin_sent && t->snd_nxt == t->fin_seq && can >= 1) {
            uint32_t fin_end = seq_add(t->fin_seq, 1);
            int is_new = seq_geq(t->fin_seq, t->snd_max);
            tsend(t, F_FIN | F_ACK, t->fin_seq, 0, !is_new);
            track(t, t->fin_seq, fin_end, is_new);
            t->snd_nxt = fin_end;
            if (is_new) t->snd_max = fin_end;
            t->fin_sent = 1;
            arm_rto(t);
            if (t->state == TS_ESTABLISHED) t->state = TS_FIN_WAIT_1;
            else if (t->state == TS_CLOSE_WAIT) t->state = TS_LAST_ACK;
        }
        break;
    }

    /* zero-window persist */
    uint32_t end = t->fin_requested ? t->fin_seq : t->write_seq;
    int have_more = seq_gt(end, t->snd_nxt) || (t->fin_requested && !t->fin_sent);
    if (t->snd_wnd == 0 && have_more && flight_size(t) == 0 && !t->persist_deadline) {
        t->persist_backoff = dmax(RTO_MIN, t->rto);
        t->persist_deadline = g_now + t->persist_backoff;
    }
}

void tcp_tick(uint32_t now) {
    g_now = now;
    for (int i = 0; i < MAX_CONNS; i++) {
        struct tcb *t = &g_conns[i];
        if (!t->used || t->done) continue;
        drain_app(t);
        service_timers(t);
        if (t->done) continue;
        send_segments(t);
    }
}

int32_t tcp_reap(void) {
    int completed = 0;
    for (int i = 0; i < MAX_CONNS; i++) {
        struct tcb *t = &g_conns[i];
        if (t->used && t->done) {
            if (t->fin_sent && t->app_to_send > 0) { completed++; g_completed++; }
            t->used = 0;
        }
    }
    return completed;
}

int32_t tcp_active_conns(void) {
    int n = 0;
    for (int i = 0; i < MAX_CONNS; i++) if (g_conns[i].used && !g_conns[i].done) n++;
    return n;
}

/* ---- getters / setters ---------------------------------------------------- */
static struct tcb *C(int32_t cid) { return (cid >= 0 && cid < MAX_CONNS && g_conns[cid].used) ? &g_conns[cid] : 0; }
int32_t tcp_state(int32_t cid) { struct tcb *t = C(cid); return t ? t->state : -1; }
int32_t tcp_done(int32_t cid) { struct tcb *t = C(cid); return t ? t->done : 1; }
int32_t tcp_fin_sent(int32_t cid) { struct tcb *t = C(cid); return t ? t->fin_sent : 0; }
double tcp_cwnd(int32_t cid) { struct tcb *t = C(cid); return t ? t->cwnd : 0; }
double tcp_ssthresh(int32_t cid) { struct tcb *t = C(cid); return t ? t->ssthresh : 0; }
double tcp_srtt(int32_t cid) { struct tcb *t = C(cid); return t ? t->srtt : 0; }
int32_t tcp_snd_wnd(int32_t cid) { struct tcb *t = C(cid); return t ? t->snd_wnd : 0; }
int32_t tcp_in_fast_recovery(int32_t cid) { struct tcb *t = C(cid); return t ? t->in_fast_recovery : 0; }
int32_t tcp_persist_armed(int32_t cid) { struct tcb *t = C(cid); return (t && t->persist_deadline) ? 1 : 0; }
int32_t tcp_loss_events(int32_t cid) { struct tcb *t = C(cid); return t ? t->loss_events : 0; }
uint32_t tcp_bytes_delivered(int32_t cid) { struct tcb *t = C(cid); return t ? t->bytes_delivered : 0; }
uint32_t tcp_deliver_hash(int32_t cid) { struct tcb *t = C(cid); return t ? t->deliver_hash : 0; }
uint32_t tcp_flight(int32_t cid) { struct tcb *t = C(cid); return t ? flight_size(t) : 0; }
int32_t tcp_app_to_send(int32_t cid) { struct tcb *t = C(cid); return t ? t->app_to_send : 0; }
int32_t tcp_local_port(int32_t cid) { struct tcb *t = C(cid); return t ? t->local_port : -1; }
void tcp_set_read_rate(int32_t cid, double r) {
    struct tcb *t = C(cid); if (!t) return;
    if (r < 0) t->read_instant = 1;
    else { t->read_instant = 0; t->read_rate = r; }
}
void tcp_set_rcv_buf(int32_t cid, int32_t bytes) { struct tcb *t = C(cid); if (t) t->rcv_buf = bytes; }
