package main

import (
	"encoding/json"
	"fmt"
	"os"
	"sync"
)

// Line-delimited JSON over stdin/stdout. Each line is exactly one envelope.
//
// Inbound (from Bun): Request envelopes only.
// Outbound (to Bun): Response envelopes (matched by id) and Event envelopes (no id).

type Request struct {
	ID     string          `json:"id"`
	Type   string          `json:"type"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params,omitempty"`
}

type Response struct {
	ID     string `json:"id"`
	Type   string `json:"type"`
	Result any    `json:"result,omitempty"`
	Error  string `json:"error,omitempty"`
}

type Event struct {
	Type string `json:"type"`
	Name string `json:"name"`
	Data any    `json:"data,omitempty"`
}

var writeMu sync.Mutex

func writeJSON(v any) error {
	writeMu.Lock()
	defer writeMu.Unlock()
	enc := json.NewEncoder(os.Stdout)
	return enc.Encode(v)
}

func respondOK(id string, result any) {
	if err := writeJSON(Response{ID: id, Type: "response", Result: result}); err != nil {
		fmt.Fprintf(os.Stderr, "bk1-playroom: write response failed: %v\n", err)
	}
}

func respondErr(id string, msg string) {
	if err := writeJSON(Response{ID: id, Type: "response", Error: msg}); err != nil {
		fmt.Fprintf(os.Stderr, "bk1-playroom: write response failed: %v\n", err)
	}
}

func emit(name string, data any) {
	if err := writeJSON(Event{Type: "event", Name: name, Data: data}); err != nil {
		fmt.Fprintf(os.Stderr, "bk1-playroom: write event failed: %v\n", err)
	}
}
