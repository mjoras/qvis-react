// Command qloggen generates example qlog traces with quic-go.
//
// It runs an HTTP/3 server and an HTTP/3 client (both quic-go) in one process.
// They talk through an emulated network path: a UDP proxy that adds a fixed
// round-trip time, random loss, and optionally a bandwidth-limited drop-tail
// bottleneck. The client can also migrate to a new local UDP socket in the
// middle of the connection. Every connection writes one qlog JSON-SEQ trace per
// endpoint: <out>/<name>_client.sqlog and <out>/<name>_server.sqlog.
//
// It is meant to be built against quic-go v0.64.1 with the qlog-latest patch
// applied (see README.md), which makes quic-go emit qlog that conforms to
// draft-ietf-quic-qlog-main-schema-14, quic-events-13 and h3-events-13.
package main

import (
	"bufio"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"math/big"
	mrand "math/rand"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/quic-go/quic-go"
	"github.com/quic-go/quic-go/http3"
	h3qlog "github.com/quic-go/quic-go/http3/qlog"
	"github.com/quic-go/quic-go/qlog"
	"github.com/quic-go/quic-go/qlogwriter"
)

// ---------------------------------------------------------------- flag types

// byteSize parses sizes like 1200, 50KB, 1.5MB, 64KiB, 100MiB (KB = 1000, KiB = 1024).
type byteSize int64

func (b *byteSize) String() string { return strconv.FormatInt(int64(*b), 10) }

func (b *byteSize) Set(s string) error {
	v, err := parseWithUnit(s, map[string]float64{
		"": 1, "b": 1,
		"k": 1e3, "kb": 1e3, "kib": 1 << 10,
		"m": 1e6, "mb": 1e6, "mib": 1 << 20,
		"g": 1e9, "gb": 1e9, "gib": 1 << 30,
	})
	if err != nil {
		return err
	}
	*b = byteSize(v)
	return nil
}

// bitRate parses rates like 20Mbit, 20Mbps, 500kbit, 1Gbit (bits per second); 0 means unlimited.
type bitRate float64

func (r *bitRate) String() string { return strconv.FormatFloat(float64(*r), 'f', -1, 64) }

func (r *bitRate) Set(s string) error {
	v, err := parseWithUnit(s, map[string]float64{
		"": 1, "bit": 1, "bps": 1,
		"k": 1e3, "kbit": 1e3, "kbps": 1e3,
		"m": 1e6, "mbit": 1e6, "mbps": 1e6,
		"g": 1e9, "gbit": 1e9, "gbps": 1e9,
	})
	if err != nil {
		return err
	}
	*r = bitRate(v)
	return nil
}

func parseWithUnit(s string, units map[string]float64) (float64, error) {
	s = strings.TrimSpace(s)
	i := len(s)
	for i > 0 && (s[i-1] < '0' || s[i-1] > '9') && s[i-1] != '.' {
		i--
	}
	num, unit := s[:i], strings.ToLower(s[i:])
	mult, ok := units[unit]
	if !ok {
		return 0, fmt.Errorf("unknown unit %q", unit)
	}
	v, err := strconv.ParseFloat(num, 64)
	if err != nil {
		return 0, err
	}
	return v * mult, nil
}

// ---------------------------------------------------------------- emulated network path

// link is one direction of the emulated path: random loss, then a FIFO
// bottleneck with a limited rate and a drop-tail buffer, then a fixed delay.
type link struct {
	name       string
	delay      time.Duration // one-way propagation delay
	loss       float64       // random loss probability
	rate       float64       // bottleneck rate in bytes per second, 0 = unlimited
	queueLimit int           // bottleneck buffer in bytes (only used with a rate)

	mu        sync.Mutex
	rng       *mrand.Rand
	lossOff   bool
	busyUntil time.Time // when the bottleneck finishes serializing the queued packets

	pipe chan delayedPacket

	forwarded, randomDrops, queueDrops atomic.Int64
}

type delayedPacket struct {
	data    []byte
	at      time.Time
	deliver func([]byte)
}

func newLink(name string, delay time.Duration, loss, rate float64, queueLimit int, seed int64) *link {
	l := &link{
		name:       name,
		delay:      delay,
		loss:       loss,
		rate:       rate,
		queueLimit: queueLimit,
		rng:        mrand.New(mrand.NewSource(seed)),
		pipe:       make(chan delayedPacket, 1<<16),
	}
	go l.run()
	return l
}

// run delivers packets in order. Delivery times never decrease (FIFO bottleneck,
// constant delay), so a single goroutine keeps the packet order intact.
func (l *link) run() {
	for p := range l.pipe {
		if d := time.Until(p.at); d > 0 {
			time.Sleep(d)
		}
		p.deliver(p.data)
	}
}

func (l *link) send(data []byte, deliver func([]byte)) {
	now := time.Now()
	l.mu.Lock()
	if !l.lossOff && l.loss > 0 && l.rng.Float64() < l.loss {
		l.mu.Unlock()
		l.randomDrops.Add(1)
		return
	}
	departure := now
	if l.rate > 0 {
		start := now
		if l.busyUntil.After(now) {
			start = l.busyUntil
		}
		queued := l.busyUntil.Sub(now).Seconds() * l.rate // bytes waiting in the buffer
		if queued < 0 {
			queued = 0
		}
		if int(queued)+len(data) > l.queueLimit {
			l.mu.Unlock()
			l.queueDrops.Add(1)
			return
		}
		departure = start.Add(time.Duration(float64(len(data)) / l.rate * float64(time.Second)))
		l.busyUntil = departure
	}
	l.mu.Unlock()
	l.forwarded.Add(1)
	l.pipe <- delayedPacket{data: data, at: departure.Add(l.delay), deliver: deliver}
}

func (l *link) disableLoss() {
	l.mu.Lock()
	l.lossOff = true
	l.mu.Unlock()
}

func (l *link) stats() string {
	return fmt.Sprintf("%s: %d forwarded, %d random drops, %d bottleneck drops",
		l.name, l.forwarded.Load(), l.randomDrops.Load(), l.queueDrops.Load())
}

// proxy forwards datagrams between clients and the server. Every client address
// gets its own upstream socket (like a NAT), so the server sees a new remote
// address when the client migrates.
type proxy struct {
	pc         *net.UDPConn
	serverAddr *net.UDPAddr
	up, down   *link

	mu       sync.Mutex
	upstream map[string]*net.UDPConn
}

func (p *proxy) run() {
	buf := make([]byte, 2048)
	for {
		n, caddr, err := p.pc.ReadFromUDP(buf)
		if err != nil {
			return
		}
		data := append([]byte(nil), buf[:n]...)
		uc, err := p.upstreamFor(caddr)
		if err != nil {
			log.Printf("proxy: %v", err)
			continue
		}
		p.up.send(data, func(b []byte) { uc.Write(b) })
	}
}

func (p *proxy) upstreamFor(caddr *net.UDPAddr) (*net.UDPConn, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if uc, ok := p.upstream[caddr.String()]; ok {
		return uc, nil
	}
	uc, err := net.DialUDP("udp", nil, p.serverAddr)
	if err != nil {
		return nil, err
	}
	p.upstream[caddr.String()] = uc
	go func() { // server -> this client
		buf := make([]byte, 2048)
		for {
			n, err := uc.Read(buf)
			if err != nil {
				return
			}
			data := append([]byte(nil), buf[:n]...)
			p.down.send(data, func(b []byte) { p.pc.WriteToUDP(b, caddr) })
		}
	}()
	return uc, nil
}

func (p *proxy) close() {
	p.pc.Close()
	p.mu.Lock()
	for _, uc := range p.upstream {
		uc.Close()
	}
	p.mu.Unlock()
}

// ---------------------------------------------------------------- qlog output

// traceFiles creates one .sqlog file per connection and endpoint, and lets the
// caller wait until quic-go has written and closed all of them.
type traceFiles struct {
	dir, name string
	schemas   []string

	wg    sync.WaitGroup
	mu    sync.Mutex
	paths []string
}

type traceFile struct {
	*bufio.Writer
	f    *os.File
	once sync.Once
	done func()
}

func (t *traceFile) Close() error {
	var err error
	t.once.Do(func() {
		err = errors.Join(t.Flush(), t.f.Close())
		t.done()
	})
	return err
}

func (tf *traceFiles) tracer(_ context.Context, isClient bool, connID quic.ConnectionID) qlogwriter.Trace {
	label := "server"
	if isClient {
		label = "client"
	}
	tf.mu.Lock()
	path := filepath.Join(tf.dir, fmt.Sprintf("%s_%s.sqlog", tf.name, label))
	for _, p := range tf.paths {
		if p == path { // more than one connection: disambiguate by the ODCID
			path = filepath.Join(tf.dir, fmt.Sprintf("%s_%s_%s.sqlog", tf.name, connID, label))
			break
		}
	}
	tf.paths = append(tf.paths, path)
	tf.mu.Unlock()

	f, err := os.Create(path)
	if err != nil {
		log.Printf("creating qlog file failed: %v", err)
		return nil
	}
	tf.wg.Add(1)
	w := &traceFile{Writer: bufio.NewWriterSize(f, 1<<20), f: f, done: tf.wg.Done}
	seq := qlogwriter.NewConnectionFileSeq(w, isClient, connID, tf.schemas)
	go seq.Run()
	return seq
}

func (tf *traceFiles) wait(timeout time.Duration) bool {
	done := make(chan struct{})
	go func() { tf.wg.Wait(); close(done) }()
	select {
	case <-done:
		return true
	case <-time.After(timeout):
		return false
	}
}

// ---------------------------------------------------------------- main

func tlsConfig() *tls.Config {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		log.Fatal(err)
	}
	tmpl := x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{CommonName: "localhost"},
		DNSNames:     []string{"localhost"},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(24 * time.Hour),
	}
	der, err := x509.CreateCertificate(rand.Reader, &tmpl, &tmpl, &key.PublicKey, key)
	if err != nil {
		log.Fatal(err)
	}
	return &tls.Config{
		Certificates: []tls.Certificate{{Certificate: [][]byte{der}, PrivateKey: key}},
		NextProtos:   []string{http3.NextProtoH3},
	}
}

func listenUDP() *net.UDPConn {
	c, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		log.Fatal(err)
	}
	return c
}

func main() {
	var size, queue byteSize = 200_000, 0
	var bw bitRate
	out := flag.String("out", "", "output directory for the .sqlog files (default: $QLOGDIR, else \"out\")")
	name := flag.String("name", "trace", "file name prefix: <out>/<name>_client.sqlog and <out>/<name>_server.sqlog")
	nreq := flag.Int("n", 1, "number of HTTP/3 requests")
	flag.Var(&size, "size", "response body size per request, e.g. 50KB, 1MB, 100MiB")
	sequential := flag.Bool("sequential", false, "send the requests one after another instead of in parallel")
	stagger := flag.Duration("stagger", 0, "delay between starting two parallel requests")
	priority := flag.String("priority", "u=3, i", "value of the priority request header (RFC 9218), empty: none")
	loss := flag.Float64("loss", 0, "random loss probability, applied in both directions")
	lossUp := flag.Float64("loss-up", -1, "random loss probability client -> server; negative: the value of -loss")
	lossDown := flag.Float64("loss-down", -1, "random loss probability server -> client; negative: the value of -loss")
	rtt := flag.Duration("rtt", 40*time.Millisecond, "round-trip time added by the proxy (half in each direction)")
	flag.Var(&bw, "bw", "bottleneck bandwidth in each direction, e.g. 20Mbit (default: unlimited)")
	flag.Var(&queue, "queue", "bottleneck buffer size, e.g. 64KB (default: one bandwidth-delay product, at least 16KB)")
	migrate := flag.Duration("migrate", 0, "if > 0: the client migrates to a new UDP socket this long after the handshake (probe, then switch)")
	cidLen := flag.Int("cid-len", 8, "length of the connection IDs chosen by client and server (4 to 20)")
	seed := flag.Int64("seed", 1, "seed for the random loss decisions")
	keepLoss := flag.Bool("loss-during-close", false, "keep dropping packets while the connection is closed (default: loss stops once all responses are received, so both endpoints log a clean close)")
	timeout := flag.Duration("timeout", 5*time.Minute, "overall timeout")
	flag.Parse()

	if *out == "" {
		*out = os.Getenv("QLOGDIR")
		if *out == "" {
			*out = "out"
		}
	}
	if err := os.MkdirAll(*out, 0o755); err != nil {
		log.Fatal(err)
	}
	if *lossUp < 0 {
		*lossUp = *loss
	}
	if *lossDown < 0 {
		*lossDown = *loss
	}
	rate := float64(bw) / 8
	queueLimit := int(queue)
	if rate > 0 && queueLimit == 0 {
		queueLimit = max(int(rate*rtt.Seconds()), 16_000)
	}

	tf := &traceFiles{dir: *out, name: *name, schemas: []string{qlog.EventSchema, h3qlog.EventSchema, qlog.LogLevelEventSchema}}

	// server
	payload := make([]byte, 64*1024)
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/octet-stream")
		w.Header().Set("content-length", strconv.FormatInt(int64(size), 10))
		for remaining := int64(size); remaining > 0; {
			n := min(remaining, int64(len(payload)))
			if _, err := w.Write(payload[:n]); err != nil {
				return
			}
			remaining -= n
		}
	})
	serverConn := listenUDP()
	serverTr := &quic.Transport{Conn: serverConn, ConnectionIDLength: *cidLen}
	ln, err := serverTr.ListenEarly(tlsConfig(), &quic.Config{Tracer: tf.tracer})
	if err != nil {
		log.Fatal(err)
	}
	srv := &http3.Server{Handler: mux}
	go srv.ServeListener(ln)

	// network path
	px := &proxy{
		pc:         listenUDP(),
		serverAddr: serverConn.LocalAddr().(*net.UDPAddr),
		up:         newLink("client->server", *rtt/2, *lossUp, rate, queueLimit, *seed*2),
		down:       newLink("server->client", *rtt/2, *lossDown, rate, queueLimit, *seed*2+1),
		upstream:   map[string]*net.UDPConn{},
	}
	go px.run()
	proxyAddr := px.pc.LocalAddr().(*net.UDPAddr)

	// client
	clientTr := &quic.Transport{Conn: listenUDP(), ConnectionIDLength: *cidLen}
	connCh := make(chan *quic.Conn, 1)
	h3tr := &http3.Transport{
		TLSClientConfig: &tls.Config{InsecureSkipVerify: true, ServerName: "localhost"},
		QUICConfig:      &quic.Config{Tracer: tf.tracer},
		Dial: func(ctx context.Context, _ string, tlsConf *tls.Config, conf *quic.Config) (*quic.Conn, error) {
			conn, err := clientTr.DialEarly(ctx, proxyAddr, tlsConf, conf)
			if err == nil {
				select {
				case connCh <- conn:
				default:
				}
			}
			return conn, err
		},
	}
	cl := &http.Client{Transport: h3tr, Timeout: *timeout}

	if *migrate > 0 {
		go func() {
			conn := <-connCh
			select {
			case <-conn.HandshakeComplete():
			case <-conn.Context().Done():
				return
			}
			time.Sleep(*migrate)
			newTr := &quic.Transport{Conn: listenUDP(), ConnectionIDLength: *cidLen}
			path, err := conn.AddPath(newTr)
			if err != nil {
				log.Printf("migration: adding path failed: %v", err)
				return
			}
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			if err := path.Probe(ctx); err != nil {
				log.Printf("migration: probing %s failed: %v", newTr.Conn.LocalAddr(), err)
				return
			}
			if err := path.Switch(); err != nil {
				log.Printf("migration: switching to %s failed: %v", newTr.Conn.LocalAddr(), err)
				return
			}
			log.Printf("migration: client switched to %s", newTr.Conn.LocalAddr())
		}()
	}

	start := time.Now()
	var received atomic.Int64
	var failed atomic.Int32
	get := func(i int) {
		req, err := http.NewRequest(http.MethodGet, fmt.Sprintf("https://localhost:%d/file-%d.bin", proxyAddr.Port, i), nil)
		if err != nil {
			log.Fatal(err)
		}
		if *priority != "" {
			req.Header.Set("priority", *priority)
		}
		resp, err := cl.Do(req)
		if err != nil {
			log.Printf("request %d failed: %v", i, err)
			failed.Add(1)
			return
		}
		n, err := io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
		if err != nil || n != int64(size) {
			log.Printf("request %d: received %d of %d bytes (%v)", i, n, int64(size), err)
			failed.Add(1)
		}
		received.Add(n)
	}
	if *sequential {
		for i := range *nreq {
			get(i)
		}
	} else {
		var wg sync.WaitGroup
		for i := range *nreq {
			wg.Add(1)
			go func() { defer wg.Done(); get(i) }()
			if *stagger > 0 && i < *nreq-1 {
				time.Sleep(*stagger)
			}
		}
		wg.Wait()
	}
	elapsed := time.Since(start)

	// Close the connection. Unless asked otherwise, stop dropping packets first,
	// such that the CONNECTION_CLOSE reaches the server and both traces end cleanly.
	if !*keepLoss {
		px.up.disableLoss()
		px.down.disableLoss()
	}
	h3tr.Close()
	if !tf.wait(5 * time.Second) {
		srv.Close()
		if !tf.wait(5 * time.Second) {
			log.Printf("warning: not all qlog traces were closed")
		}
	}
	srv.Close()
	px.close()

	log.Printf("%s: %d request(s), %d bytes in %v (%.1f Mbit/s goodput), %d failed",
		*name, *nreq, received.Load(), elapsed.Round(time.Millisecond),
		float64(received.Load())*8/elapsed.Seconds()/1e6, failed.Load())
	log.Printf("%s; %s", px.up.stats(), px.down.stats())
	for _, p := range tf.paths {
		if fi, err := os.Stat(p); err == nil {
			log.Printf("wrote %s (%d bytes)", p, fi.Size())
		}
	}
	if failed.Load() > 0 {
		os.Exit(1)
	}
}
