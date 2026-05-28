// TypeScript mirror of the line protocol implemented in
// sidecars/playroom/protocol.go. Newline-delimited JSON over the
// sidecar's stdin/stdout. Keep these shapes in sync with the Go side.

export type PlayroomMethod = 'init' | 'create' | 'join' | 'leave' | 'send';

export interface InitResult { hostname: string; }
export interface CreateResult { address: string; }
export interface JoinResult { joined: true; }
export interface LeaveResult { left: true; }
export interface SendResult { sent: true; }

export type PlayroomEvent =
  | { name: 'auth_url'; data: { url: string } }
  | { name: 'peer_connected'; data: { from: string } }
  | { name: 'peer_disconnected'; data: Record<string, never> }
  | { name: 'peer_message'; data: { line: string } }
  | { name: 'error'; data: { msg: string } };

export type PlayroomEventName = PlayroomEvent['name'];
