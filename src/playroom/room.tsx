import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { PlayroomSidecar } from './sidecar';
import { PetSpriteLine } from '../app';
import { petSprite, petColorHex, type PetState } from '../pet';
import { encodeMessage, parseGameMessage } from './messages';
import { isValidPin, PIN_LENGTH, type PlayerRole } from './relay-protocol';
import { Jakenpoy } from './jakenpoy';
import { JakenpoySpectator } from './jakenpoy-spectator';
import { Race } from './race';
import { RaceSpectator } from './race-spectator';

type LobbyState =
  | { kind: 'starting' }
  | { kind: 'creating' }
  | { kind: 'waiting'; pin: string }
  | { kind: 'join_input'; value: string; error: string | null }
  | { kind: 'joining'; pin: string }
  | { kind: 'connected' }
  | { kind: 'spectating'; pin: string }
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
  const [role, setRole] = useState<PlayerRole | null>(null);
  const [subscreen, setSubscreen] = useState<SubScreen>('lobby');
  const [watchers, setWatchers] = useState(0);

  // Player-side pets (used in player mode).
  const [peerPet, setPeerPet] = useState<PetState | null>(null);
  // Spectator-side pets — tracked separately because the spectator sees both
  // players from the outside; `from` on incoming data attributes the hello.
  const [hostPet, setHostPet] = useState<PetState | null>(null);
  const [joinerPet, setJoinerPet] = useState<PetState | null>(null);

  const sidecarRef = useRef<PlayroomSidecar | null>(null);
  const petRef = useRef(pet);
  petRef.current = pet;
  const roleRef = useRef<PlayerRole | null>(null);
  roleRef.current = role;

  useEffect(() => {
    const sidecar = new PlayroomSidecar();
    sidecarRef.current = sidecar;

    const offConnected = sidecar.on('peer_connected', () => {
      setRole(sidecar.role);
      roleRef.current = sidecar.role;
      setState({ kind: 'connected' });
      // Hello exchange: send our pet state as soon as the channel is up.
      sidecar.send(encodeMessage({ type: 'hello', pet: petRef.current })).catch(() => {});
    });
    const offSpectated = sidecar.on('joined_as_spectator', ({ pin }) => {
      setRole('spectator');
      roleRef.current = 'spectator';
      setState({ kind: 'spectating', pin });
    });
    const offDisconnected = sidecar.on('peer_disconnected', () => {
      setPeerPet(null);
      setHostPet(null);
      setJoinerPet(null);
      setSubscreen('lobby');
      setState({ kind: 'error', msg: 'Room ended. Press esc to leave.' });
    });
    const offSpectatorJoined = sidecar.on('spectator_joined', ({ count }) => {
      setWatchers(count);
      // Re-broadcast hello so the new spectator sees our pet sprite.
      if (roleRef.current === 'host' || roleRef.current === 'joiner') {
        sidecar.send(encodeMessage({ type: 'hello', pet: petRef.current })).catch(() => {});
      }
    });
    const offSpectatorLeft = sidecar.on('spectator_left', ({ count }) => {
      setWatchers(count);
    });
    const offMessage = sidecar.on('peer_message', ({ line, from }) => {
      const msg = parseGameMessage(line);
      if (!msg) return;
      if (msg.type === 'hello') {
        if (roleRef.current === 'spectator') {
          if (from === 'host') setHostPet(msg.pet);
          else if (from === 'joiner') setJoinerPet(msg.pet);
        } else {
          setPeerPet(msg.pet);
        }
        return;
      }
      if (msg.type === 'game_started') {
        setSubscreen(msg.game);
        return;
      }
      if (msg.type === 'game_ended') {
        setSubscreen('lobby');
        return;
      }
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
          setRole('host');
          roleRef.current = 'host';
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
      offSpectated();
      offDisconnected();
      offSpectatorJoined();
      offSpectatorLeft();
      offMessage();
      offError();
      sidecar.close().catch(() => {});
    };
  }, [mode]);

  // Re-send hello whenever our pet color changes mid-session, so the peer
  // re-renders our sprite in the new color. Skipped on the initial connect
  // because the connect handler already sends hello once. Spectators don't
  // send hellos (they have no pet identity in the room).
  const firstColorRef = useRef(true);
  useEffect(() => {
    if (firstColorRef.current) { firstColorRef.current = false; return; }
    if (state.kind !== 'connected') return;
    if (roleRef.current === 'spectator') return;
    sidecarRef.current?.send(encodeMessage({ type: 'hello', pet: petRef.current })).catch(() => {});
  }, [pet.color, state.kind]);

  const launchGame = (game: 'jakenpoy' | 'race') => {
    sidecarRef.current?.send(encodeMessage({ type: 'game_started', game })).catch(() => {});
    setSubscreen(game);
  };
  const exitGame = () => {
    // Either player exiting tears down the match for everyone, including spectators.
    if (roleRef.current === 'host' || roleRef.current === 'joiner') {
      sidecarRef.current?.send(encodeMessage({ type: 'game_ended' })).catch(() => {});
    }
    setSubscreen('lobby');
  };

  useInput((input, key) => {
    if (subscreen !== 'lobby') return;
    if (key.escape) { onExit(); return; }

    const isSpectator = roleRef.current === 'spectator';
    const inRoom = state.kind === 'connected' || state.kind === 'waiting';

    // Color cycle works for players in any in-room state (broadcasts as hello
    // re-send via the color useEffect). Spectators have no pet identity to
    // change — color key is a no-op for them.
    if (inRoom && !isSpectator && input === 'c' && onCycleColor) { onCycleColor(); return; }

    if (state.kind === 'connected' && !isSpectator) {
      if (input === 'j') { launchGame('jakenpoy'); return; }
      if (input === 'r') { launchGame('race'); return; }
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
      const cleaned = input.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
      if (cleaned) {
        const next = (state.value + cleaned).slice(0, PIN_LENGTH);
        setState({ ...state, value: next, error: null });
      }
    }
  });

  // Subscreen routing — when a game is active, render its UI. Spectators get
  // the view-only variant; players get the interactive one.
  const sidecar = sidecarRef.current;
  if (subscreen === 'jakenpoy' && sidecar) {
    if (role === 'spectator') {
      return (
        <JakenpoySpectator
          hostPet={hostPet}
          joinerPet={joinerPet}
          sidecar={sidecar}
          onExit={exitGame}
        />
      );
    }
    if (state.kind === 'connected' && peerPet) {
      return <Jakenpoy pet={pet} peerPet={peerPet} sidecar={sidecar} onExit={exitGame} />;
    }
  }

  if (subscreen === 'race' && sidecar) {
    if (role === 'spectator') {
      return (
        <RaceSpectator
          hostPet={hostPet}
          joinerPet={joinerPet}
          sidecar={sidecar}
          onExit={exitGame}
        />
      );
    }
    if (state.kind === 'connected' && peerPet) {
      return <Race pet={pet} peerPet={peerPet} sidecar={sidecar} onExit={exitGame} />;
    }
  }

  return (
    <Box flexDirection="column" paddingX={1} paddingY={0}>
      <Header state={state} watchers={watchers} role={role} />
      <Box flexDirection="column" marginY={1} paddingX={2} minHeight={12}>
        <Body
          state={state}
          pet={pet}
          peerPet={peerPet}
          hostPet={hostPet}
          joinerPet={joinerPet}
          role={role}
          watchers={watchers}
        />
      </Box>
      <Box paddingX={1}>
        <Text color="gray">esc  {state.kind === 'waiting' || state.kind === 'connected' || state.kind === 'spectating' ? 'leave room' : 'cancel'}</Text>
      </Box>
    </Box>
  );
}

function Header({ state, watchers, role }: { state: LobbyState; watchers: number; role: PlayerRole | null }) {
  const status = headerStatus(state, role);
  return (
    <Box>
      <Text color="cyan" bold>playroom</Text>
      <Box flexGrow={1} />
      {watchers > 0 && (role === 'host' || role === 'joiner') && (
        <Text color="gray">{watchers} watching · </Text>
      )}
      <Text color="gray">{status}</Text>
    </Box>
  );
}

function headerStatus(state: LobbyState, role: PlayerRole | null): string {
  switch (state.kind) {
    case 'starting':   return 'connecting to relay...';
    case 'creating':   return 'creating room...';
    case 'waiting':    return 'waiting for peer';
    case 'join_input': return 'enter pin';
    case 'joining':    return 'joining...';
    case 'connected':  return role === 'spectator' ? 'spectating' : 'connected';
    case 'spectating': return 'spectating';
    case 'error':      return 'error';
  }
}

function Body({
  state, pet, peerPet, hostPet, joinerPet, role, watchers,
}: {
  state: LobbyState;
  pet: PetState;
  peerPet: PetState | null;
  hostPet: PetState | null;
  joinerPet: PetState | null;
  role: PlayerRole | null;
  watchers: number;
}) {
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
          <PetPair
            leftPet={pet} leftLabel="you"
            rightPet={null} rightLabel="(empty)"
          />
          <Text> </Text>
          <Text>Send this pin to your friend so they can join:</Text>
          <Text> </Text>
          <Text color="cyan" bold>    {state.pin}</Text>
          <Text> </Text>
          <Text color="gray">In their bk1, they type:  /pet playroom join</Text>
          <Text color="gray">Then paste the pin and hit ↵.</Text>
          {watchers > 0 && (
            <>
              <Text> </Text>
              <Text color="gray">{watchers} {watchers === 1 ? 'person is' : 'people are'} watching.</Text>
            </>
          )}
          <Text> </Text>
          <Text color="gray">c  cycle color</Text>
        </Box>
      );

    case 'join_input':
      return (
        <Box flexDirection="column">
          <Text>Enter the {PIN_LENGTH}-character pin your friend sent you.</Text>
          <Text color="gray">Letters and digits, case-insensitive. Example:  EMCQG4</Text>
          <Text color="gray">If the room is already full, you'll join as a spectator.</Text>
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
      if (role === 'spectator') {
        return (
          <Box flexDirection="column">
            <PetPair
              leftPet={hostPet}  leftLabel="host"
              rightPet={joinerPet} rightLabel="joiner"
            />
            <Text> </Text>
            <Text color="gray">spectating — you can see the match but can't play.</Text>
            <Text color="gray">When the players start a game, you'll see it too.</Text>
          </Box>
        );
      }
      return (
        <Box flexDirection="column">
          <PetPair
            leftPet={pet} leftLabel="you"
            rightPet={peerPet} rightLabel={peerPet ? 'friend' : '(empty)'}
          />
          <Text> </Text>
          <Text color="gray">j  jakenpoy   r  race   s  space impact (soon)   c  cycle color</Text>
          {watchers > 0 && (
            <>
              <Text> </Text>
              <Text color="gray">{watchers} {watchers === 1 ? 'person is' : 'people are'} watching.</Text>
            </>
          )}
        </Box>
      );

    case 'spectating':
      // Brief state between joined_as_spectator and the host/joiner's hello
      // re-broadcast. Pets render once hellos arrive.
      return (
        <Box flexDirection="column">
          <PetPair
            leftPet={hostPet}  leftLabel="host"
            rightPet={joinerPet} rightLabel="joiner"
          />
          <Text> </Text>
          <Text>Joined room {state.pin} as a spectator.</Text>
          <Text color="gray">{hostPet && joinerPet ? 'waiting for the players to start a game...' : 'waiting for player pets to load...'}</Text>
        </Box>
      );

    case 'error':
      return <Text color="red">{state.msg}</Text>;
  }
}

export function PetPair({
  leftPet, leftLabel, rightPet, rightLabel,
}: {
  leftPet: PetState | null;
  leftLabel: string;
  rightPet: PetState | null;
  rightLabel: string;
}) {
  return (
    <Box flexDirection="row">
      <Slot pet={leftPet} label={leftLabel} />
      <Slot pet={rightPet} label={rightLabel} />
    </Box>
  );
}

function Slot({ pet, label }: { pet: PetState | null; label: string }) {
  const sprite = pet ? petSprite(pet) : null;
  const name = pet?.name ?? (pet ? 'unnamed' : null);
  const color = pet ? petColorHex(pet) : undefined;
  return (
    <Box flexDirection="column" width={20}>
      <Text>{label}</Text>
      <Text> </Text>
      {sprite
        ? sprite.map((line, i) => <PetSpriteLine key={i} line={line} bodyColor={color} />)
        : <Text color="gray">  · · ·  </Text>}
      <Text>{name ?? ' '}</Text>
    </Box>
  );
}
