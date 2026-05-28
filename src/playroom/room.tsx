import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { PlayroomSidecar } from './sidecar';
import { PetSpriteLine } from '../app';
import { petSprite, petColorHex, type PetState } from '../pet';
import { encodeMessage, parseGameMessage } from './messages';
import { isValidPin, PIN_LENGTH } from './relay-protocol';
import { Jakenpoy } from './jakenpoy';
import { Race } from './race';

type LobbyState =
  | { kind: 'starting' }
  | { kind: 'creating' }
  | { kind: 'waiting'; pin: string }
  | { kind: 'join_input'; value: string; error: string | null }
  | { kind: 'joining'; pin: string }
  | { kind: 'connected' }
  | { kind: 'error'; msg: string };

export type LobbyMode =
  | { kind: 'create' }
  | { kind: 'join'; pin?: string };

type SubScreen = 'lobby' | 'jakenpoy' | 'race';

interface Props {
  mode: LobbyMode;
  pet: PetState;
  onExit: () => void;
  onCycleColor?: () => void;
}

export function PlayroomLobby({ mode, pet, onExit, onCycleColor }: Props) {
  const [state, setState] = useState<LobbyState>({ kind: 'starting' });
  const [peerPet, setPeerPet] = useState<PetState | null>(null);
  const [subscreen, setSubscreen] = useState<SubScreen>('lobby');
  const sidecarRef = useRef<PlayroomSidecar | null>(null);
  const petRef = useRef(pet);
  petRef.current = pet;

  useEffect(() => {
    const sidecar = new PlayroomSidecar();
    sidecarRef.current = sidecar;

    const offConnected = sidecar.on('peer_connected', () => {
      setState({ kind: 'connected' });
      // Hello exchange: send our pet state as soon as the channel is up.
      // Both sides do this; receive handler below stores the peer pet.
      sidecar.send(encodeMessage({ type: 'hello', pet: petRef.current })).catch(() => {});
    });
    const offDisconnected = sidecar.on('peer_disconnected', () => {
      setPeerPet(null);
      setState({ kind: 'error', msg: 'Peer left the room. Press esc to leave.' });
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
        if (mode.kind === 'create') {
          setState({ kind: 'creating' });
          const { pin } = await sidecar.create();
          setState({ kind: 'waiting', pin });
        } else if (mode.pin) {
          setState({ kind: 'joining', pin: mode.pin });
          await sidecar.join(mode.pin);
        } else {
          setState({ kind: 'join_input', value: '', error: null });
        }
      } catch (err) {
        setState({ kind: 'error', msg: err instanceof Error ? err.message : String(err) });
      }
    })();

    return () => {
      offConnected();
      offDisconnected();
      offMessage();
      offError();
      sidecar.close().catch(() => {});
    };
  }, [mode]);

  // Re-send hello whenever our pet color changes mid-session, so the peer
  // re-renders our sprite in the new color. Skipped on the initial connect
  // because the connect handler already sends hello once.
  const firstColorRef = useRef(true);
  useEffect(() => {
    if (firstColorRef.current) { firstColorRef.current = false; return; }
    if (state.kind !== 'connected') return;
    sidecarRef.current?.send(encodeMessage({ type: 'hello', pet: petRef.current })).catch(() => {});
  }, [pet.color, state.kind]);

  useInput((input, key) => {
    if (subscreen !== 'lobby') return;
    if (key.escape) { onExit(); return; }

    if (state.kind === 'connected' || state.kind === 'waiting') {
      if (input === 'c' && onCycleColor) { onCycleColor(); return; }
    }
    if (state.kind === 'connected') {
      if (input === 'j') { setSubscreen('jakenpoy'); return; }
      if (input === 'r') { setSubscreen('race'); return; }
      return;
    }

    if (state.kind !== 'join_input') return;
    if (key.return) {
      const trimmed = state.value.trim().toUpperCase();
      if (!isValidPin(trimmed)) {
        setState({ ...state, error: `pin must be ${PIN_LENGTH} characters (letters/digits, no 0/1/I/L/O)` });
        return;
      }
      setState({ kind: 'joining', pin: trimmed });
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
      // Pins are case-insensitive in display; normalize as we go.
      const cleaned = input.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
      if (cleaned) {
        const next = (state.value + cleaned).slice(0, PIN_LENGTH);
        setState({ ...state, value: next, error: null });
      }
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
      <Box flexDirection="column" marginY={1} paddingX={2} minHeight={12}>
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
    case 'starting':   return 'connecting to relay...';
    case 'creating':   return 'creating room...';
    case 'waiting':    return 'waiting for peer';
    case 'join_input': return 'enter pin';
    case 'joining':    return 'joining...';
    case 'connected':  return 'connected';
    case 'error':      return 'error';
  }
}

function Body({ state, pet, peerPet }: { state: LobbyState; pet: PetState; peerPet: PetState | null }) {
  switch (state.kind) {
    case 'starting':
    case 'creating':
    case 'joining':
      return (
        <Text color="gray">
          {state.kind === 'creating' ? 'opening a room...'
            : state.kind === 'joining' ? `joining room ${state.pin}...`
            : 'connecting to the playroom relay...'}
        </Text>
      );

    case 'waiting':
      return (
        <Box flexDirection="column">
          <PetPair pet={pet} peerPet={null} />
          <Text> </Text>
          <Text>Send this pin to your friend so they can join:</Text>
          <Text> </Text>
          <Text color="cyan" bold>    {state.pin}</Text>
          <Text> </Text>
          <Text color="gray">In their bk1, they type:  /pet playroom join</Text>
          <Text color="gray">Then paste the pin and hit ↵.</Text>
          <Text> </Text>
          <Text color="gray">c  cycle color</Text>
        </Box>
      );

    case 'join_input':
      return (
        <Box flexDirection="column">
          <Text>Enter the {PIN_LENGTH}-character pin your friend sent you.</Text>
          <Text color="gray">Letters and digits, case-insensitive. Example:  EMCQG4</Text>
          <Text> </Text>
          <Box>
            <Text color="gray">pin › </Text>
            <Text color="cyan" bold>{state.value.padEnd(PIN_LENGTH, '·')}</Text>
          </Box>
          {state.error && <Text color="red">{state.error}</Text>}
          <Text> </Text>
          <Text color="gray">↵ join     paste with Cmd+V (Ctrl+V on Linux/Win)</Text>
        </Box>
      );

    case 'connected':
      return (
        <Box flexDirection="column">
          <PetPair pet={pet} peerPet={peerPet} />
          <Text> </Text>
          <Text color="gray">j  jakenpoy   r  race   s  space impact (soon)   c  cycle color</Text>
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
  const myColor = petColorHex(pet);
  const peerColor = peerPet ? petColorHex(peerPet) : undefined;

  return (
    <Box flexDirection="row">
      <Box flexDirection="column" width={20}>
        <Text>you</Text>
        <Text> </Text>
        {mineSprite.map((line, i) => <PetSpriteLine key={i} line={line} bodyColor={myColor} />)}
        <Text>{yourName}</Text>
      </Box>
      <Box flexDirection="column" width={20}>
        <Text>{peerPet ? 'friend' : '(empty)'}</Text>
        <Text> </Text>
        {peerSprite
          ? peerSprite.map((line, i) => <PetSpriteLine key={i} line={line} bodyColor={peerColor} />)
          : <Text color="gray">  · · ·  </Text>}
        <Text>{peerName ?? ' '}</Text>
      </Box>
    </Box>
  );
}
