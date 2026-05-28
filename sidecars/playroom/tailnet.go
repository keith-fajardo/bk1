package main

import (
	"bufio"
	"context"
	"fmt"
	"net"
	"os"
	"os/user"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"tailscale.com/tsnet"
)

// One tsnet node per sidecar process. Shared state directory under ~/.bk1/playroom-state
// so the same Tailscale identity is reused across bk1 launches — appears as one device
// in the user's tailnet, not many.

type tailnet struct {
	mu       sync.Mutex
	srv      *tsnet.Server
	hostname string // short hostname passed to tsnet (e.g. "keithfajardo-bk1")
	dnsName  string // full tailnet DNS name resolved after up() (e.g. "keithfajardo-bk1.tail-corp.ts.net")

	listener net.Listener // non-nil when this side created the room
	listenPort int         // port the listener bound to; tsnet.addr doesn't expose it cleanly
	conn     net.Conn     // active peer connection (incoming or outgoing)
}

var authURLRe = regexp.MustCompile(`https://login\.tailscale\.com/a/[a-zA-Z0-9]+`)

func newTailnet() (*tailnet, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, fmt.Errorf("locate home dir: %w", err)
	}
	stateDir := filepath.Join(home, ".bk1", "playroom-state")
	if err := os.MkdirAll(stateDir, 0o700); err != nil {
		return nil, fmt.Errorf("create state dir: %w", err)
	}

	hostname := defaultHostname()

	srv := &tsnet.Server{
		Dir:       stateDir,
		Hostname:  hostname,
		Ephemeral: false,
		Logf: func(format string, args ...any) {
			msg := fmt.Sprintf(format, args...)
			if url := authURLRe.FindString(msg); url != "" {
				emit("auth_url", map[string]string{"url": url})
			}
		},
	}

	return &tailnet{srv: srv, hostname: hostname}, nil
}

func defaultHostname() string {
	u, err := user.Current()
	if err == nil && u.Username != "" {
		return sanitizeHostname(u.Username) + "-bk1"
	}
	return "bk1-instance"
}

// Tailscale hostnames must be DNS-label safe.
func sanitizeHostname(s string) string {
	s = strings.ToLower(s)
	var b strings.Builder
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9', r == '-':
			b.WriteRune(r)
		default:
			b.WriteRune('-')
		}
	}
	out := strings.Trim(b.String(), "-")
	if out == "" {
		return "bk1-instance"
	}
	return out
}

// Block until the node is authorized within the tailnet. Returns the local address.
func (t *tailnet) up(ctx context.Context) (string, error) {
	t.mu.Lock()
	defer t.mu.Unlock()

	if _, err := t.srv.Up(ctx); err != nil {
		return "", fmt.Errorf("tsnet up: %w", err)
	}

	lc, err := t.srv.LocalClient()
	if err != nil {
		return "", fmt.Errorf("local client: %w", err)
	}
	st, err := lc.Status(ctx)
	if err != nil {
		return "", fmt.Errorf("status: %w", err)
	}
	if st.Self == nil || len(st.Self.TailscaleIPs) == 0 {
		return "", fmt.Errorf("no tailscale ip assigned yet")
	}
	t.dnsName = strings.TrimSuffix(st.Self.DNSName, ".")
	return t.dnsName, nil
}

// Open a tailnet listener on a known port. tsnet's Listener.Addr() doesn't
// report the bound port the way standard net.Listen does (it returns the
// literal listen spec), so we pick the port ourselves and try a small range
// in case one's already taken in the userspace stack.
func (t *tailnet) createRoom(ctx context.Context) (string, error) {
	t.mu.Lock()
	defer t.mu.Unlock()

	if t.listener != nil {
		return "", fmt.Errorf("room already created")
	}

	const (
		basePort  = 47800
		portRange = 100
	)
	var ln net.Listener
	var port int
	var lastErr error
	for i := 0; i < portRange; i++ {
		p := basePort + i
		l, err := t.srv.Listen("tcp", fmt.Sprintf(":%d", p))
		if err == nil {
			ln = l
			port = p
			break
		}
		lastErr = err
	}
	if ln == nil {
		return "", fmt.Errorf("listen: exhausted %d ports starting at %d, last err: %w", portRange, basePort, lastErr)
	}
	t.listener = ln
	t.listenPort = port

	go t.acceptLoop(ln)

	// Prefer the full tailnet DNS name (resolved during up()), since that's what
	// the peer can actually dial via MagicDNS. Fall back to the short hostname
	// only as a defensive measure — shouldn't happen in practice.
	host := t.dnsName
	if host == "" {
		host = t.hostname
	}
	return fmt.Sprintf("%s:%d", host, port), nil
}

func (t *tailnet) acceptLoop(ln net.Listener) {
	for {
		conn, err := ln.Accept()
		if err != nil {
			// listener closed → we're done; otherwise surface as an event.
			if strings.Contains(err.Error(), "use of closed") {
				return
			}
			emit("error", map[string]string{"msg": fmt.Sprintf("accept: %v", err)})
			return
		}
		t.mu.Lock()
		if t.conn != nil {
			// Already have a peer. Refuse the second one for phase 1 — two-peer rooms only.
			t.mu.Unlock()
			conn.Close()
			continue
		}
		t.conn = conn
		t.mu.Unlock()
		emit("peer_connected", map[string]string{"from": conn.RemoteAddr().String()})
		go t.readLoop(conn)
	}
}

// Dial a peer's room (hostname:port) over the tailnet.
func (t *tailnet) joinRoom(ctx context.Context, address string) error {
	t.mu.Lock()
	if t.conn != nil {
		t.mu.Unlock()
		return fmt.Errorf("already in a room")
	}
	t.mu.Unlock()

	dialCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()

	conn, err := t.srv.Dial(dialCtx, "tcp", address)
	if err != nil {
		return fmt.Errorf("dial %s: %w", address, err)
	}
	t.mu.Lock()
	t.conn = conn
	t.mu.Unlock()
	emit("peer_connected", map[string]string{"from": address})
	go t.readLoop(conn)
	return nil
}

func (t *tailnet) leave() {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.conn != nil {
		t.conn.Close()
		t.conn = nil
	}
	if t.listener != nil {
		t.listener.Close()
		t.listener = nil
	}
}

// Phase 2: line-framed reader. Each newline-terminated chunk is surfaced as a
// peer_message event with the line content. Empty lines are skipped.
func (t *tailnet) readLoop(conn net.Conn) {
	scanner := bufio.NewScanner(conn)
	scanner.Buffer(make([]byte, 64*1024), 1024*1024)
	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			continue
		}
		emit("peer_message", map[string]string{"line": line})
	}
	t.mu.Lock()
	same := t.conn == conn
	if same {
		t.conn = nil
	}
	t.mu.Unlock()
	if same {
		emit("peer_disconnected", map[string]string{})
	}
}

// Send a single line of text to the peer (a newline is appended). Used for
// the framed game-message protocol on top of the data channel.
func (t *tailnet) send(data string) error {
	t.mu.Lock()
	conn := t.conn
	t.mu.Unlock()
	if conn == nil {
		return fmt.Errorf("no peer connected")
	}
	if _, err := conn.Write([]byte(data + "\n")); err != nil {
		return fmt.Errorf("write peer: %w", err)
	}
	return nil
}

func (t *tailnet) close() {
	t.leave()
	if t.srv != nil {
		_ = t.srv.Close()
	}
}
