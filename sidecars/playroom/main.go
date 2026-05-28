// bk1-playroom — Tailscale-embedded sidecar for the bk1 playroom feature.
//
// Long-lived child process. Speaks newline-delimited JSON over stdin/stdout
// to the bk1 Bun process. Each line of stdin is a Request; each line of
// stdout is either a Response (with matching id) or an Event (no id).
//
// Phase 1 surface: init, create, join, leave. No game framing yet.

package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/signal"
	"syscall"
)

var tn *tailnet

func main() {
	// Stderr is a free channel — used for human-readable diagnostic logs,
	// never read by Bun. Stdout is reserved for the JSON line protocol.
	var err error
	tn, err = newTailnet()
	if err != nil {
		fmt.Fprintf(os.Stderr, "bk1-playroom: init failed: %v\n", err)
		os.Exit(1)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Graceful shutdown on SIGINT/SIGTERM: close tsnet so it persists state
	// cleanly and doesn't leak the listener.
	sigs := make(chan os.Signal, 1)
	signal.Notify(sigs, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-sigs
		tn.close()
		os.Exit(0)
	}()

	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 64*1024), 1024*1024)
	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}
		var req Request
		if err := json.Unmarshal(line, &req); err != nil {
			fmt.Fprintf(os.Stderr, "bk1-playroom: parse request: %v\n", err)
			continue
		}
		dispatch(ctx, req)
	}
	tn.close()
}

func dispatch(ctx context.Context, req Request) {
	switch req.Method {
	case "init":
		hostname, err := tn.up(ctx)
		if err != nil {
			respondErr(req.ID, err.Error())
			return
		}
		respondOK(req.ID, map[string]string{"hostname": hostname})

	case "create":
		address, err := tn.createRoom(ctx)
		if err != nil {
			respondErr(req.ID, err.Error())
			return
		}
		respondOK(req.ID, map[string]string{"address": address})

	case "join":
		var p struct {
			Address string `json:"address"`
		}
		if err := json.Unmarshal(req.Params, &p); err != nil {
			respondErr(req.ID, fmt.Sprintf("bad params: %v", err))
			return
		}
		if p.Address == "" {
			respondErr(req.ID, "address is required")
			return
		}
		if err := tn.joinRoom(ctx, p.Address); err != nil {
			respondErr(req.ID, err.Error())
			return
		}
		respondOK(req.ID, map[string]bool{"joined": true})

	case "leave":
		tn.leave()
		respondOK(req.ID, map[string]bool{"left": true})

	default:
		respondErr(req.ID, fmt.Sprintf("unknown method: %s", req.Method))
	}
}
