import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { PlayroomSidecar } from './sidecar';
import { PetSpriteLine } from '../app';
import { petSprite, type PetState } from '../pet';

// Lobby states. Drives the body of the modal.
type LobbyState =
  | { kind: 'starting' }
  | { kind: 'auth_required'; url: string }
  | { kind: 'creating' }
  | { kind: 'waiting'; address: string }
  | { kind: 'join_input'; value: string; error: string | null }
  | { kind: 'joining'; address: string }
  | { kind: 'connected'; peer: string }
  | { kind: 'error'; msg: string };

export type LobbyMode =
  | { kind: 'create' }
  | { kind: 'join'; address?: string };

interface Props {
  mode: LobbyMode;
  pet: PetState;
  onExit: () => void;
}

export function PlayroomLobby({ mode, pet, onExit }: Props) {
  const [state, setState] = useState<LobbyState>({ kind: 'starting' });
  const sidecarRef = useRef<PlayroomSidecar | null>(null);

  useEffect(() => {
    const sidecar = new PlayroomSidecar();
    sidecarRef.current = sidecar;

    const offAuth = sidecar.on('auth_url', ({ url }) => {
      setState(s => s.kind === 'starting' ? { kind: 'auth_required', url } : s);
    });
    const offConnected = sidecar.on('peer_connected', ({ from }) => {
      setState({ kind: 'connected', peer: from });
    });
    const offDisconnected = sidecar.on('peer_disconnected', () => {
      setState({ kind: 'error', msg: 'Peer disconnected. Press esc to leave.' });
    });
    const offError = sidecar.on('error', ({ msg }) => {
      setState({ kind: 'error', msg });
    });

    (async () => {
      try {
        await sidecar.start();
        await sidecar.init();
        if (mode.kind === 'create') {
          setState({ kind: 'creating' });
          const { address } = await sidecar.create();
          setState({ kind: 'waiting', address });
        } else if (mode.address) {
          setState({ kind: 'joining', address: mode.address });
          await sidecar.join(mode.address);
        } else {
          setState({ kind: 'join_input', value: '', error: null });
        }
      } catch (err) {
        setState({ kind: 'error', msg: err instanceof Error ? err.message : String(err) });
      }
    })();

    return () => {
      offAuth();
      offConnected();
      offDisconnected();
      offError();
      sidecar.leave().catch(() => {});
      sidecar.close().catch(() => {});
    };
  }, [mode]);

  useInput((input, key) => {
    if (key.escape) {
      onExit();
      return;
    }
    if (state.kind !== 'join_input') return;
    if (key.return) {
      const trimmed = state.value.trim();
      if (!trimmed) {
        setState({ ...state, error: 'address is required' });
        return;
      }
      setState({ kind: 'joining', address: trimmed });
      sidecarRef.current?.join(trimmed).catch(err => {
        setState({ kind: 'error', msg: err instanceof Error ? err.message : String(err) });
      });
      return;
    }
    if (key.backspace || key.delete) {
      setState({ ...state, value: state.value.slice(0, -1), error: null });
      return;
    }
    if (input && !key.ctrl && !key.meta) {
      const cleaned = input.replace(/[\r\n\t]/g, '');
      if (cleaned) setState({ ...state, value: state.value + cleaned, error: null });
    }
  });

  return (
    <Box flexDirection="column" paddingX={1} paddingY={0}>
      <Header state={state} />
      <Box flexDirection="column" marginY={1} paddingX={2} minHeight={14}>
        <Body state={state} pet={pet} />
      </Box>
      <Box paddingX={1}>
        <Text color="gray">esc  {state.kind === 'waiting' || state.kind === 'connected' ? 'leave room' : 'cancel'}</Text>
      </Box>
    </Box>
  );
}

function Header({ state }: { state: LobbyState }) {
  const status = headerStatus(state);
  return (
    <Box>
      <Text color="cyan" bold>playroom</Text>
      <Box flexGrow={1} />
      <Text color="gray">{status}</Text>
    </Box>
  );
}

function headerStatus(state: LobbyState): string {
  switch (state.kind) {
    case 'starting':       return 'starting...';
    case 'auth_required':  return 'auth required';
    case 'creating':       return 'creating room...';
    case 'waiting':        return 'waiting for peer';
    case 'join_input':     return 'enter address';
    case 'joining':        return 'joining...';
    case 'connected':      return 'connected';
    case 'error':          return 'error';
  }
}

function Body({ state, pet }: { state: LobbyState; pet: PetState }) {
  switch (state.kind) {
    case 'starting':
    case 'creating':
    case 'joining':
      return <Text color="gray">{state.kind === 'creating' ? 'opening a room on your tailnet...' : state.kind === 'joining' ? `dialing ${state.address}...` : 'starting tailnet...'}</Text>;

    case 'auth_required':
      return (
        <Box flexDirection="column">
          <Text>First-time setup: authorize this device with Tailscale so your pet can reach the playroom mesh.</Text>
          <Text> </Text>
          <Text>Open this URL in your browser:</Text>
          <Text> </Text>
          <Text color="cyan">    {state.url}</Text>
          <Text> </Text>
          <Text color="gray">Waiting for authorization...</Text>
        </Box>
      );

    case 'waiting':
      return (
        <Box flexDirection="column">
          <PetPair pet={pet} peerPresent={false} />
          <Text> </Text>
          <Text>Share this with your friend so they can join:</Text>
          <Text> </Text>
          <Text color="cyan">    {state.address}</Text>
        </Box>
      );

    case 'join_input':
      return (
        <Box flexDirection="column">
          <Text>Enter the tailnet address your friend shared with you:</Text>
          <Text> </Text>
          <Box>
            <Text color="gray">address › </Text>
            <Text>{state.value || ' '}</Text>
          </Box>
          {state.error && <Text color="red">{state.error}</Text>}
          <Text> </Text>
          <Text color="gray">↵ join</Text>
        </Box>
      );

    case 'connected':
      return (
        <Box flexDirection="column">
          <PetPair pet={pet} peerPresent={true} peerLabel={state.peer} />
          <Text> </Text>
          <Text color="gray">/pet play jakenpoy   /pet play race   /pet play space-impact</Text>
        </Box>
      );

    case 'error':
      return <Text color="red">{state.msg}</Text>;
  }
}

function PetPair({ pet, peerPresent, peerLabel }: { pet: PetState; peerPresent: boolean; peerLabel?: string }) {
  // Phase 1: real sprite for self; friend slot is a placeholder until phase 2
  // adds pet-state exchange over the data channel.
  const sprite = petSprite(pet);
  const yourName = pet.name ?? 'motchi';
  return (
    <Box flexDirection="row">
      <Box flexDirection="column" width={20}>
        <Text>you</Text>
        <Text> </Text>
        {sprite.map((line, i) => <PetSpriteLine key={i} line={line} />)}
        <Text>{yourName}</Text>
      </Box>
      <Box flexDirection="column" width={20}>
        <Text>{peerPresent ? 'friend' : '(empty)'}</Text>
        <Text> </Text>
        <Text color="gray">{peerPresent ? '  (•‿•)  ' : '  · · ·  '}</Text>
        <Text> </Text>
        <Text> </Text>
        <Text color="gray">{peerPresent ? (peerLabel ?? 'connected') : ' '}</Text>
      </Box>
    </Box>
  );
}
