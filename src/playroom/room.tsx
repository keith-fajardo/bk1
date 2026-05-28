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

// In-room actions, in the order shown to the user. The arrow-key cursor
// in the connected state cycles through this list; Enter executes; the
// `shortcut` letter is also accepted as a direct accelerator.
type ActionId = 'jakenpoy' | 'race' | 'space-impact' | 'cycle-color' | 'change-alias';
const CONNECTED_ACTIONS: { id: ActionId; label: string; shortcut: string; disabled?: boolean }[] = [
  { id: 'jakenpoy',     label: 'Jakenpoy',                shortcut: 'j' },
  { id: 'race',         label: 'Race',                    shortcut: 'r' },
  { id: 'space-impact', label: 'Space Impact (soon)',     shortcut: 's', disabled: true },
  { id: 'cycle-color',  label: 'Cycle pet color',         shortcut: 'c' },
  { id: 'change-alias', label: 'Change alias',            shortcut: 'a' },
];

interface Props {
  mode: LobbyMode;
  pet: PetState;
  // Session-only display name override. When set, it's used in place of
  // pet.name when this client sends a hello to the relay, so peers and
  // spectators see this string as the player's name.
  sessionAlias: string | null;
  onSetAlias: (alias: string | null) => void;
  onExit: () => void;
  onCycleColor?: () => void;
}

export function PlayroomLobby({ mode, pet, sessionAlias, onSetAlias, onExit, onCycleColor }: Props) {
  const [state, setState] = useState<LobbyState>({ kind: 'starting' });
  const [role, setRole] = useState<PlayerRole | null>(null);
  const [subscreen, setSubscreen] = useState<SubScreen>('lobby');
  const [watchers, setWatchers] = useState(0);
  // Cursor index into CONNECTED_ACTIONS for the connected-state menu.
  const [actionIdx, setActionIdx] = useState(0);
  // When non-null, the lobby is showing the alias-edit text field (overlaying
  // the connected-state menu). Esc cancels without saving; Enter saves.
  const [aliasEditing, setAliasEditing] = useState<{ value: string } | null>(null);

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
  // Mirror sessionAlias in a ref so the long-lived peer_message handlers
  // (registered once via useEffect([])) read the freshest alias when they
  // build a hello to re-broadcast.
  const aliasRef = useRef(sessionAlias);
  aliasRef.current = sessionAlias;

  // Build a hello payload with the user's chosen alias (if any) overriding
  // pet.name. Peer/spectator clients just render whatever `name` they see —
  // they don't know or care that it's an alias.
  const buildHello = (): string => {
    const p = petRef.current;
    const a = aliasRef.current;
    return encodeMessage({
      type: 'hello',
      pet: a ? { ...p, name: a } : p,
    });
  };

  useEffect(() => {
    const sidecar = new PlayroomSidecar();
    sidecarRef.current = sidecar;

    const offConnected = sidecar.on('peer_connected', () => {
      setRole(sidecar.role);
      roleRef.current = sidecar.role;
      setState({ kind: 'connected' });
      // Hello exchange: send our pet state as soon as the channel is up.
      sidecar.send(buildHello()).catch(() => {});
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
        sidecar.send(buildHello()).catch(() => {});
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
    sidecarRef.current?.send(buildHello()).catch(() => {});
  }, [pet.color, sessionAlias, state.kind]);

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
  const runAction = (id: ActionId): void => {
    switch (id) {
      case 'jakenpoy':     launchGame('jakenpoy'); return;
      case 'race':         launchGame('race'); return;
      case 'cycle-color':  if (onCycleColor) onCycleColor(); return;
      case 'change-alias': setAliasEditing({ value: sessionAlias ?? '' }); return;
      case 'space-impact': /* not yet implemented — picker shows it disabled */ return;
    }
  };

  useInput((input, key) => {
    if (subscreen !== 'lobby') return;

    // Alias-edit text field takes priority over everything else when active.
    // Esc cancels (returns to menu without saving); Enter saves the trimmed
    // value (or clears the alias if empty); chars/backspace edit the buffer.
    if (aliasEditing) {
      if (key.escape) { setAliasEditing(null); return; }
      if (key.return) {
        const trimmed = aliasEditing.value.trim();
        onSetAlias(trimmed.length > 0 ? trimmed : null);
        setAliasEditing(null);
        return;
      }
      if (key.backspace || key.delete) {
        setAliasEditing({ value: aliasEditing.value.slice(0, -1) });
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        // Allow letters, digits, space, and common punctuation. Cap at a
        // reasonable display width so it doesn't blow out the layout.
        const cleaned = input.replace(/[\r\n\t]/g, '');
        if (cleaned) {
          const next = (aliasEditing.value + cleaned).slice(0, 20);
          setAliasEditing({ value: next });
        }
      }
      return;
    }

    if (key.escape) { onExit(); return; }

    const isSpectator = roleRef.current === 'spectator';
    const inRoom = state.kind === 'connected' || state.kind === 'waiting';

    // Color cycle works for players in any in-room state (broadcasts as hello
    // re-send via the color useEffect). Spectators have no pet identity to
    // change — color key is a no-op for them.
    if (inRoom && !isSpectator && input === 'c' && onCycleColor) { onCycleColor(); return; }

    if (state.kind === 'connected' && !isSpectator) {
      // Arrow-key menu navigation over CONNECTED_ACTIONS. Single-letter
      // shortcuts (j/r/s/c) below still work as direct accelerators for
      // power users.
      if (key.upArrow) {
        const n = CONNECTED_ACTIONS.length;
        setActionIdx(i => (i - 1 + n) % n);
        return;
      }
      if (key.downArrow) {
        const n = CONNECTED_ACTIONS.length;
        setActionIdx(i => (i + 1) % n);
        return;
      }
      if (key.return) {
        const action = CONNECTED_ACTIONS[actionIdx];
        if (action && !action.disabled) runAction(action.id);
        return;
      }
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
  // the view-only variant; players get the interactive one. Edge case: a
  // player can launch a game before the peer's hello has arrived (rare race,
  // but possible if you click immediately on connect). When that happens
  // peerPet is null and the game can't render. Previously this fell through
  // to the lobby silently, which looked like "I clicked but nothing happened."
  // Now we render a clear waiting placeholder.
  const sidecar = sidecarRef.current;

  const isGameSubscreen = subscreen === 'jakenpoy' || subscreen === 'race';
  if (isGameSubscreen && sidecar) {
    if (role === 'spectator') {
      const SpecComponent = subscreen === 'jakenpoy' ? JakenpoySpectator : RaceSpectator;
      return (
        <SpecComponent
          hostPet={hostPet}
          joinerPet={joinerPet}
          sidecar={sidecar}
          onExit={exitGame}
        />
      );
    }
    // Player path — need peerPet to render the interactive game.
    if (state.kind === 'connected' && peerPet) {
      if (subscreen === 'jakenpoy') {
        return <Jakenpoy pet={pet} peerPet={peerPet} sidecar={sidecar} onExit={exitGame} />;
      }
      return <Race pet={pet} peerPet={peerPet} sidecar={sidecar} onExit={exitGame} />;
    }
    if (state.kind === 'connected' && !peerPet) {
      // Hello hasn't arrived yet — show an explicit waiting state so the
      // click doesn't look ignored. Once peerPet lands via the peer_message
      // handler this re-renders into the actual game.
      return (
        <Box flexDirection="column" paddingX={1} paddingY={0}>
          <Box>
            <Text color="cyan" bold>{subscreen}</Text>
            <Box flexGrow={1} />
            <Text color="gray">syncing with peer...</Text>
          </Box>
          <Box flexDirection="column" marginY={1} paddingX={2} minHeight={6}>
            <Text color="gray">Waiting for your friend's pet info to arrive over the relay.</Text>
            <Text color="gray">If this hangs more than a few seconds, your friend's bk1 may</Text>
            <Text color="gray">be on an older build or their connection dropped.</Text>
            <Text> </Text>
            <Text color="gray">esc  back to lobby</Text>
          </Box>
        </Box>
      );
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
          actionIdx={actionIdx}
          sessionAlias={sessionAlias}
          aliasEditing={aliasEditing}
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
  state, pet, peerPet, hostPet, joinerPet, role, watchers, actionIdx, sessionAlias, aliasEditing,
}: {
  state: LobbyState;
  pet: PetState;
  peerPet: PetState | null;
  hostPet: PetState | null;
  joinerPet: PetState | null;
  role: PlayerRole | null;
  watchers: number;
  actionIdx: number;
  sessionAlias: string | null;
  aliasEditing: { value: string } | null;
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
            leftPet={pet} leftLabel={`you${sessionAlias ? ` (${sessionAlias})` : ''}`}
            rightPet={peerPet} rightLabel={peerPet ? 'friend' : '(empty)'}
          />
          <Text> </Text>
          {/* Both branches use the same outer Box flexDirection="column" so
              React's reconciler keeps the subtree stable across the menu
              ↔ alias-input swap. Switching between Box and fragment can
              force a remount of children, which in turn loses internal
              state held by descendants. */}
          <Box flexDirection="column">
            {aliasEditing ? (
              <>
                <Text>Change alias — what should your friend see as your name?</Text>
                <Text color="gray">Leave empty and press ↵ to clear (uses pet name: {pet.name ?? 'motchi'}).</Text>
                <Text> </Text>
                <Box>
                  <Text color="gray">alias › </Text>
                  <Text color="cyan" bold>{aliasEditing.value || ' '}</Text>
                </Box>
                <Text> </Text>
                <Text color="gray">↵ save · esc cancel · up to 20 characters</Text>
              </>
            ) : (
              <>
                <Text>games:</Text>
                {CONNECTED_ACTIONS.map((a, i) => {
                  const active = i === actionIdx;
                  const color = a.disabled
                    ? '#3D6650'                       // dim — not yet implemented
                    : active ? '#C0FAD2' : 'gray';
                  return (
                    <Box key={a.id}>
                      <Text color={color}>{active ? '  > ' : '    '}</Text>
                      <Text color={color} bold={active && !a.disabled}>
                        {a.label}
                      </Text>
                    </Box>
                  );
                })}
                <Text> </Text>
                <Text color="gray">↑↓ navigate · ↵ select · shortcut letters also work</Text>
                {watchers > 0 && (
                  <>
                    <Text> </Text>
                    <Text color="gray">{watchers} {watchers === 1 ? 'person is' : 'people are'} watching.</Text>
                  </>
                )}
              </>
            )}
          </Box>
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
