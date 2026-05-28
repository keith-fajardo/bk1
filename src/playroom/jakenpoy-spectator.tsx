// View-only jakenpoy for spectators. Tracks both players' choices independently
// via the `from` field on relayed data, computes the running score locally,
// and renders the same scoreboard + fighter pair the players see — minus the
// picker. No keyboard input is consumed beyond `esc` to leave.

import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { PetSpriteLine } from '../app';
import { petSprite, type PetState } from '../pet';
import type { PlayroomSidecar } from './sidecar';
import {
  parseGameMessage,
  jakenpoyWinner,
  type JakenpoyChoice,
} from './messages';

const WIN_AT = 2;

// Text-only labels — see PICKER_OPTIONS comment in jakenpoy.tsx. Emoji
// glyphs crash Yoga during layout measurement.
const CHOICE_LABELS: Record<JakenpoyChoice, string> = {
  papel:   'Papel',
  gunting: 'Gunting',
  bato:    'Bato',
};

function prettyVerdict(winner: JakenpoyChoice, loser: JakenpoyChoice): string {
  if (winner === 'bato'    && loser === 'gunting') return `${CHOICE_LABELS.bato} dulls ${CHOICE_LABELS.gunting}`;
  if (winner === 'gunting' && loser === 'papel'  ) return `${CHOICE_LABELS.gunting} cuts ${CHOICE_LABELS.papel}`;
  if (winner === 'papel'   && loser === 'bato'   ) return `${CHOICE_LABELS.papel} wraps ${CHOICE_LABELS.bato}`;
  return '';
}

type SpectatorPhase =
  | { kind: 'choosing'; host: JakenpoyChoice | null; joiner: JakenpoyChoice | null }
  | { kind: 'reveal'; host: JakenpoyChoice; joiner: JakenpoyChoice }
  | { kind: 'match_over'; host: JakenpoyChoice; joiner: JakenpoyChoice };

interface Props {
  hostPet: PetState | null;
  joinerPet: PetState | null;
  sidecar: PlayroomSidecar;
  onExit: () => void;
}

export function JakenpoySpectator({ hostPet, joinerPet, sidecar, onExit }: Props) {
  const [round, setRound] = useState(1);
  const [score, setScore] = useState({ host: 0, joiner: 0 });
  const [phase, setPhase] = useState<SpectatorPhase>({ kind: 'choosing', host: null, joiner: null });
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const scoreRef = useRef(score);
  scoreRef.current = score;
  const roundRef = useRef(round);
  roundRef.current = round;

  useInput((_input, key) => {
    if (key.escape) onExit();
  });

  useEffect(() => {
    const off = sidecar.on('peer_message', ({ line, from }) => {
      const msg = parseGameMessage(line);
      if (!msg) return;
      if (msg.type === 'jakenpoy_quit') return; // lobby handles game_ended
      if (msg.type !== 'jakenpoy_choice') return;
      if (from !== 'host' && from !== 'joiner') return;

      // New round detection: any choice arriving while we're showing reveal
      // means the players have advanced. Reset before storing.
      let working: SpectatorPhase = phaseRef.current;
      if (working.kind === 'reveal') {
        working = { kind: 'choosing', host: null, joiner: null };
        setRound(r => {
          // Treat a tie as same round number — players replay it. Otherwise advance.
          // We can't tell a tie from a non-tie just from the next choice's round
          // value, so trust the incoming round number from the player.
          const next = Math.max(r, msg.round);
          roundRef.current = next;
          return next;
        });
      }
      if (working.kind === 'match_over') {
        return; // match is locked; lobby will route us out via game_ended
      }

      // Store the choice for the right player.
      const updated: SpectatorPhase = {
        kind: 'choosing',
        host:   from === 'host'   ? msg.choice : working.host,
        joiner: from === 'joiner' ? msg.choice : working.joiner,
      };

      // Both in? Resolve.
      if (updated.host && updated.joiner) {
        const outcome = jakenpoyWinner(updated.host, updated.joiner);
        const nextScore = { ...scoreRef.current };
        if (outcome === 'me')  nextScore.host  = nextScore.host  + 1;
        if (outcome === 'you') nextScore.joiner = nextScore.joiner + 1;
        if (outcome !== 'tie') {
          setScore(nextScore);
          scoreRef.current = nextScore;
        }
        const next: SpectatorPhase =
          nextScore.host >= WIN_AT || nextScore.joiner >= WIN_AT
            ? { kind: 'match_over', host: updated.host, joiner: updated.joiner }
            : { kind: 'reveal',     host: updated.host, joiner: updated.joiner };
        setPhase(next);
        phaseRef.current = next;
      } else {
        setPhase(updated);
        phaseRef.current = updated;
      }
    });
    return off;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const hostName = hostPet?.name ?? 'host';
  const joinerName = joinerPet?.name ?? 'joiner';
  const roundLabel = phase.kind === 'match_over' ? 'match over' : `round ${round}/3 · best of 3`;
  const scoreLabel = `${hostName} ${score.host}  /  ${joinerName} ${score.joiner}`;

  const hostUnggoy   = phase.kind === 'match_over' && score.joiner > score.host;
  const joinerUnggoy = phase.kind === 'match_over' && score.host > score.joiner;

  return (
    <Box flexDirection="column" paddingX={1} paddingY={0}>
      <Box>
        <Text color="cyan" bold>jakenpoy</Text>
        <Box flexGrow={1} />
        <Text color="gray">spectating · {roundLabel}</Text>
      </Box>

      <Box flexDirection="column" marginY={1} paddingX={2} minHeight={16}>
        <Box>
          <Text color="gray">scoreboard:  </Text>
          <Text bold>{scoreLabel}</Text>
        </Box>

        <Text> </Text>

        <FighterPair
          hostPet={hostPet}
          joinerPet={joinerPet}
          hostLabel={fighterLabel(phase, 'host')}
          joinerLabel={fighterLabel(phase, 'joiner')}
          hostUnggoy={hostUnggoy}
          joinerUnggoy={joinerUnggoy}
        />

        <Text> </Text>

        {phase.kind === 'choosing' && (
          <Box flexDirection="column">
            <Box>
              <Text>{hostName.padEnd(12)}: </Text>
              <Text color={phase.host ? 'green' : 'gray'}>
                {phase.host ? '✓ locked in' : '· still picking'}
              </Text>
            </Box>
            <Box>
              <Text>{joinerName.padEnd(12)}: </Text>
              <Text color={phase.joiner ? 'green' : 'gray'}>
                {phase.joiner ? '✓ locked in' : '· still picking'}
              </Text>
            </Box>
          </Box>
        )}

        {phase.kind === 'reveal' && (
          <RevealSummary host={phase.host} joiner={phase.joiner} hostName={hostName} joinerName={joinerName} />
        )}

        {phase.kind === 'match_over' && (
          <MatchOverSummary host={phase.host} joiner={phase.joiner} score={score} hostName={hostName} joinerName={joinerName} />
        )}
      </Box>

      <Box paddingX={1}>
        <Text color="gray">esc  leave game</Text>
      </Box>
    </Box>
  );
}

function fighterLabel(phase: SpectatorPhase, side: 'host' | 'joiner'): string {
  if (phase.kind === 'reveal' || phase.kind === 'match_over') {
    return CHOICE_LABELS[side === 'host' ? phase.host : phase.joiner];
  }
  const c = side === 'host' ? phase.host : phase.joiner;
  if (c) return CHOICE_LABELS[c];
  // Other player has locked in but this one hasn't yet — show '?' as a hint.
  const otherLocked = side === 'host' ? phase.joiner !== null : phase.host !== null;
  return otherLocked ? '?' : '';
}

function FighterPair({
  hostPet, joinerPet, hostLabel, joinerLabel, hostUnggoy, joinerUnggoy,
}: {
  hostPet: PetState | null;
  joinerPet: PetState | null;
  hostLabel: string;
  joinerLabel: string;
  hostUnggoy: boolean;
  joinerUnggoy: boolean;
}) {
  return (
    <Box flexDirection="row">
      <Side pet={hostPet}   defaultLabel="host"   choiceLabel={hostLabel}   unggoy={hostUnggoy} />
      <Side pet={joinerPet} defaultLabel="joiner" choiceLabel={joinerLabel} unggoy={joinerUnggoy} />
    </Box>
  );
}

function Side({
  pet, defaultLabel, choiceLabel, unggoy,
}: {
  pet: PetState | null;
  defaultLabel: string;
  choiceLabel: string;
  unggoy: boolean;
}) {
  const sprite = pet ? petSprite(pet) : null;
  const name = pet?.name ?? defaultLabel;
  return (
    <Box flexDirection="column" width={22}>
      <Text>{name}{unggoy ? ' (unggoy)' : ''}</Text>
      <Text> </Text>
      <Box flexDirection="row">
        <Box flexDirection="column">
          {sprite
            ? sprite.map((line, i) => <PetSpriteLine key={i} line={line} />)
            : <Text color="gray">  · · ·  </Text>}
        </Box>
        <Box marginLeft={2}><Text color={choiceLabel ? 'cyan' : 'gray'}>{choiceLabel || ' '}</Text></Box>
      </Box>
    </Box>
  );
}

function RevealSummary({
  host, joiner, hostName, joinerName,
}: {
  host: JakenpoyChoice; joiner: JakenpoyChoice; hostName: string; joinerName: string;
}) {
  const outcome = jakenpoyWinner(host, joiner); // 'me' = host wins, 'you' = joiner wins, 'tie'
  let headline: string;
  let sub: string;
  let color: 'green' | 'red' | 'gray';
  if (outcome === 'tie') {
    headline = `${CHOICE_LABELS[host]} vs ${CHOICE_LABELS[joiner]} — tie`;
    sub = 'they will replay the round';
    color = 'gray';
  } else if (outcome === 'me') {
    headline = prettyVerdict(host, joiner);
    sub = `${hostName} wins this round`;
    color = 'green';
  } else {
    headline = prettyVerdict(joiner, host);
    sub = `${joinerName} wins this round`;
    color = 'red';
  }
  return (
    <Box flexDirection="column">
      <Text>{headline}</Text>
      <Text color={color}>{sub}</Text>
      <Text> </Text>
      <Text color="gray">waiting for next round...</Text>
    </Box>
  );
}

function MatchOverSummary({
  host, joiner, score, hostName, joinerName,
}: {
  host: JakenpoyChoice; joiner: JakenpoyChoice;
  score: { host: number; joiner: number };
  hostName: string; joinerName: string;
}) {
  const hostWon = score.host > score.joiner;
  const winner = hostWon ? hostName : joinerName;
  return (
    <Box flexDirection="column">
      <Text>{winner} wins {Math.max(score.host, score.joiner)}-{Math.min(score.host, score.joiner)}</Text>
      <Text color="gray">sinong matalo, siyang unggoy</Text>
      <Text> </Text>
      <Text color="gray">final picks: {hostName} {CHOICE_LABELS[host]} · {joinerName} {CHOICE_LABELS[joiner]}</Text>
      <Text> </Text>
      <Text color="gray">waiting for the players to return to the lobby...</Text>
    </Box>
  );
}
