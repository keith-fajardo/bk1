import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { PlayroomSidecar } from './sidecar';
import { PetSpriteLine } from '../app';
import { petSprite, type PetState } from '../pet';
import { encodeMessage, parseGameMessage } from './messages';
import { Jakenpoy } from './jakenpoy';
import { Race } from './race';

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

type SubScreen = 'lobby' | 'jakenpoy' | 'race';

interface Props {
  mode: LobbyMode;
  pet: PetState;
  onExit: () => void;
}

export function PlayroomLobby({ mode, pet, onExit }: Props) {
  const [state, setState] = useState<LobbyState>({ kind: 'starting' });
  const [peerPet, setPeerPet] = useState<PetState | null>(null);
  const [subscreen, setSubscreen] = useState<SubScreen>('lobby');
  const sidecarRef = useRef<PlayroomSidecar | null>(null);
  const petRef = useRef(pet);
  petRef.current = pet;

  useEffect(() => {
    const sidecar = new PlayroomSidecar();
    sidecarRef.current = sidecar;

    const offAuth = sidecar.on('auth_url', ({ url }) => {
      setState(s => s.kind === 'starting' ? { kind: 'auth_required', url } : s);
    });
    const offConnected = sidecar.on('peer_connected', ({ from }) => {
      setState({ kind: 'connected', peer: from });
      // Hello exchange: send our pet state as soon as the channel is up.
      // Both sides do this; receive handler below stores the peer pet.
      sidecar.send(encodeMessage({ type: 'hello', pet: petRef.current })).catch(() => {});
    });
    const offDisconnected = sidecar.on('peer_disconnected', () => {
      setPeerPet(null);
      setState({ kind: 'error', msg: 'Peer disconnected. Press esc to leave.' });
    });
    const offMessage = sidecar.on('peer_message', ({ line }) => {
      const msg = parseGameMessage(line);
      if (!msg) return;
      if (msg.type === 'hello') setPeerPet(msg.pet);
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
      offMessage();
      offError();
      sidecar.leave().catch(() => {});
      sidecar.close().catch(() => {});
    };
  }, [mode]);

  useInput((input, key) => {
    // Subscreen owns its own input.
    if (subscreen !== 'lobby') return;

    if (key.escape) { onExit(); return; }

    if (state.kind === 'connected') {
      if (input === 'j') { setSubscreen('jakenpoy'); return; }
      if (input === 'r') { setSubscreen('race'); return; }
      return;
    }

    if (state.kind !== 'join_input') return;
    if (key.return) {
      const trimmed = state.value.trim();
      if (!trimmed) { setState({ ...state, error: 'address is required' }); return; }
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

  if (subscreen === 'jakenpoy' && state.kind === 'connected' && peerPet && sidecarRef.current) {
    return (
      <Jakenpoy
        pet={pet}
        peerPet={peerPet}
        sidecar={sidecarRef.current}
        onExit={() => setSubscreen('lobby')}
      />
    );
  }

  if (subscreen === 'race' && state.kind === 'connected' && peerPet && sidecarRef.current) {
    return (
      <Race
        pet={pet}
        peerPet={peerPet}
        sidecar={sidecarRef.current}
        onExit={() => setSubscreen('lobby')}
      />
    );
  }

  return (
    <Box flexDirection="column" paddingX={1} paddingY={0}>
      <Header state={state} />
      <Box flexDirection="column" marginY={1} paddingX={2} minHeight={14}>
        <Body state={state} pet={pet} peerPet={peerPet} />
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

function Body({ state, pet, peerPet }: { state: LobbyState; pet: PetState; peerPet: PetState | null }) {
  switch (state.kind) {
    case 'starting':
    case 'creating':
    case 'joining':
      return <Text color="gray">{state.kind === 'creating' ? 'opening a room on your tailnet...' : state.kind === 'joining' ? `dialing ${state.address}...` : 'starting tailnet...'}</Text>;

    case 'auth_required':
      return (
        <Box flexDirection="column">
          <Text>First-time setup: authorize this device with Tailscale.</Text>
          <Text color="gray">Tailscale is the private mesh network bk1 uses to connect pets directly,</Text>
          <Text color="gray">without exposing your machine to the public internet. Free for personal use.</Text>
          <Text> </Text>
          <Text>1. Open this URL in your browser:</Text>
          <Text> </Text>
          <Text color="cyan">     {state.url}</Text>
          <Text> </Text>
          <Text>2. Sign in with Google / GitHub / Microsoft / email (creates a free account</Text>
          <Text>   if you don't have one).</Text>
          <Text> </Text>
          <Text>3. Click "Connect" to authorize this bk1 device. You won't be asked again.</Text>
          <Text> </Text>
          <Text color="gray">To play with a friend later: both of you do the steps above, then one</Text>
          <Text color="gray">of you shares this device from login.tailscale.com/admin/machines.</Text>
          <Text> </Text>
          <Text color="gray">Waiting for authorization...</Text>
        </Box>
      );

    case 'waiting':
      return (
        <Box flexDirection="column">
          <PetPair pet={pet} peerPet={null} />
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
          <PetPair pet={pet} peerPet={peerPet} />
          <Text> </Text>
          <Text color="gray">j  jakenpoy   r  race   s  space impact (soon)</Text>
        </Box>
      );

    case 'error':
      return <Text color="red">{state.msg}</Text>;
  }
}

export function PetPair({ pet, peerPet }: { pet: PetState; peerPet: PetState | null }) {
  const mineSprite = petSprite(pet);
  const peerSprite = peerPet ? petSprite(peerPet) : null;
  const yourName = pet.name ?? 'motchi';
  const peerName = peerPet?.name ?? (peerPet ? 'unnamed' : null);

  return (
    <Box flexDirection="row">
      <Box flexDirection="column" width={20}>
        <Text>you</Text>
        <Text> </Text>
        {mineSprite.map((line, i) => <PetSpriteLine key={i} line={line} />)}
        <Text>{yourName}</Text>
      </Box>
      <Box flexDirection="column" width={20}>
        <Text>{peerPet ? 'friend' : '(empty)'}</Text>
        <Text> </Text>
        {peerSprite
          ? peerSprite.map((line, i) => <PetSpriteLine key={i} line={line} />)
          : <Text color="gray">  · · ·  </Text>}
        <Text>{peerName ?? ' '}</Text>
      </Box>
    </Box>
  );
}
