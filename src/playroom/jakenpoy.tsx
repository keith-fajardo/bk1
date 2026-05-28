import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { PetSpriteLine } from '../app';
import { petSprite, type PetState } from '../pet';
import type { PlayroomSidecar } from './sidecar';
import {
  encodeMessage,
  parseGameMessage,
  jakenpoyWinner,
  type JakenpoyChoice,
} from './messages';

const WIN_AT = 2; // best of 3 → first to 2

// Picker option order chosen by user — Papel first, then Gunting, then Bato.
// The arrow-key cursor cycles within this array; Enter locks in.
const PICKER_OPTIONS: { id: JakenpoyChoice; emoji: string; label: string }[] = [
  { id: 'papel',   emoji: '📄', label: 'Papel'   },
  { id: 'gunting', emoji: '✂️',  label: 'Gunting' },
  { id: 'bato',    emoji: '🪨', label: 'Bato'    },
];

function choiceLabel(c: JakenpoyChoice): string {
  const o = PICKER_OPTIONS.find(o => o.id === c);
  return o ? `${o.emoji} ${o.label}` : c;
}

// Verdict line for the reveal screen, using the emoji-decorated choice
// names. Falls back silently to '' for unknown combinations — pure helper.
function prettyVerdict(winner: JakenpoyChoice, loser: JakenpoyChoice): string {
  if (winner === 'bato'    && loser === 'gunting') return `${choiceLabel('bato')} dulls ${choiceLabel('gunting')}`;
  if (winner === 'gunting' && loser === 'papel'  ) return `${choiceLabel('gunting')} cuts ${choiceLabel('papel')}`;
  if (winner === 'papel'   && loser === 'bato'   ) return `${choiceLabel('papel')} wraps ${choiceLabel('bato')}`;
  return '';
}

type Phase =
  | { kind: 'choosing' }
  | { kind: 'reveal'; mine: JakenpoyChoice; theirs: JakenpoyChoice }
  | { kind: 'match_over'; mine: JakenpoyChoice; theirs: JakenpoyChoice };

interface Props {
  pet: PetState;
  peerPet: PetState;
  sidecar: PlayroomSidecar;
  onExit: () => void;
}

export function Jakenpoy({ pet, peerPet, sidecar, onExit }: Props) {
  const [round, setRound] = useState(1);
  const [score, setScore] = useState({ me: 0, you: 0 });
  const [phase, setPhase] = useState<Phase>({ kind: 'choosing' });
  const myChoiceRef = useRef<JakenpoyChoice | null>(null);
  const theirChoiceRef = useRef<JakenpoyChoice | null>(null);
  const [myChoiceDisplay, setMyChoiceDisplay] = useState<JakenpoyChoice | null>(null);
  const [theirLocked, setTheirLocked] = useState(false);
  // Picker cursor — index into PICKER_OPTIONS. Resets to 0 on each new round.
  const [pickerIdx, setPickerIdx] = useState(0);
  const roundRef = useRef(round);
  roundRef.current = round;

  // Try to resolve the round if both choices are in. Stable across re-renders
  // via refs (the choices land via different code paths — keyboard vs network).
  const tryResolve = () => {
    const mine = myChoiceRef.current;
    const theirs = theirChoiceRef.current;
    if (!mine || !theirs) return;
    const outcome = jakenpoyWinner(mine, theirs);
    let nextScore = score;
    if (outcome === 'me') nextScore = { ...score, me: score.me + 1 };
    if (outcome === 'you') nextScore = { ...score, you: score.you + 1 };
    if (outcome !== 'tie') setScore(nextScore);

    if (nextScore.me >= WIN_AT || nextScore.you >= WIN_AT) {
      setPhase({ kind: 'match_over', mine, theirs });
    } else {
      setPhase({ kind: 'reveal', mine, theirs });
    }
  };

  useEffect(() => {
    const offMessage = sidecar.on('peer_message', ({ line }) => {
      const msg = parseGameMessage(line);
      if (!msg) return;
      if (msg.type === 'jakenpoy_quit') {
        onExit();
        return;
      }
      if (msg.type === 'jakenpoy_choice' && msg.round === roundRef.current) {
        theirChoiceRef.current = msg.choice;
        setTheirLocked(true);
        tryResolve();
      }
    });
    return () => {
      offMessage();
      // Best-effort signal to peer that we're leaving the match.
      sidecar.send(encodeMessage({ type: 'jakenpoy_quit' })).catch(() => {});
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useInput((input, key) => {
    if (key.escape) {
      onExit();
      return;
    }
    if (phase.kind === 'choosing') {
      if (myChoiceRef.current) return; // already locked
      if (key.upArrow) {
        setPickerIdx(i => (i - 1 + PICKER_OPTIONS.length) % PICKER_OPTIONS.length);
        return;
      }
      if (key.downArrow) {
        setPickerIdx(i => (i + 1) % PICKER_OPTIONS.length);
        return;
      }
      if (key.return) {
        const choice = PICKER_OPTIONS[pickerIdx]!.id;
        myChoiceRef.current = choice;
        setMyChoiceDisplay(choice);
        sidecar.send(encodeMessage({
          type: 'jakenpoy_choice',
          round: roundRef.current,
          choice,
        })).catch(() => {});
        tryResolve();
      }
      return;
    }
    if (phase.kind === 'reveal') {
      if (key.return) {
        // Tie: stay on same round number, just reset choices.
        const wasTie = phase.mine === phase.theirs;
        if (!wasTie) setRound(r => r + 1);
        myChoiceRef.current = null;
        theirChoiceRef.current = null;
        setMyChoiceDisplay(null);
        setTheirLocked(false);
        setPickerIdx(0);
        setPhase({ kind: 'choosing' });
      }
      return;
    }
    if (phase.kind === 'match_over') {
      if (key.return) onExit();
    }
  });

  const roundLabel = phase.kind === 'match_over' ? 'match over' : `round ${round}/3 · best of 3`;
  const scoreLabel = `you ${score.me}  /  friend ${score.you}`;

  const iLost = phase.kind === 'match_over' && score.you > score.me;
  const youLost = phase.kind === 'match_over' && score.me > score.you;

  return (
    <Box flexDirection="column" paddingX={1} paddingY={0}>
      <Box>
        <Text color="cyan" bold>jakenpoy</Text>
        <Box flexGrow={1} />
        <Text color="gray">{roundLabel}</Text>
      </Box>

      <Box flexDirection="column" marginY={1} paddingX={2} minHeight={16}>
        {/* Persistent scoreboard so neither side has to guess the running tally. */}
        <Box>
          <Text color="gray">scoreboard:  </Text>
          <Text bold>{scoreLabel}</Text>
        </Box>

        <Text> </Text>

        <FighterPair
          pet={pet}
          peerPet={peerPet}
          mineLabel={fighterLabel(phase, 'me', myChoiceDisplay)}
          theirsLabel={fighterLabel(phase, 'you', theirLocked ? '?' : null)}
          iLost={iLost}
          youLost={youLost}
        />

        <Text> </Text>

        {phase.kind === 'choosing' && (
          <Box flexDirection="column">
            {/* Lock-in status for both sides. Updates the instant a choice is
                made locally OR an opponent's choice arrives over the wire, so
                you never wonder if you're waiting on them or they on you. */}
            <Box>
              <Text>you:    </Text>
              <Text color={myChoiceDisplay ? 'green' : 'gray'}>
                {myChoiceDisplay ? '✓ locked in' : '· still picking'}
              </Text>
            </Box>
            <Box>
              <Text>friend: </Text>
              <Text color={theirLocked ? 'green' : 'gray'}>
                {theirLocked ? '✓ locked in' : '· still picking'}
              </Text>
            </Box>
            <Text> </Text>
            {myChoiceDisplay ? (
              <Text color="gray">{theirLocked ? 'resolving round...' : 'waiting for friend to pick...'}</Text>
            ) : (
              <>
                <Text>pick:</Text>
                {PICKER_OPTIONS.map((opt, i) => {
                  const active = i === pickerIdx;
                  return (
                    <Box key={opt.id}>
                      <Text color={active ? '#C0FAD2' : 'gray'}>{active ? '  ❯ ' : '    '}</Text>
                      <Text color={active ? '#C0FAD2' : 'gray'} bold={active}>{opt.emoji}  {opt.label}</Text>
                    </Box>
                  );
                })}
                <Text> </Text>
                <Text color="gray">  ↑↓ navigate · ↵ lock in</Text>
              </>
            )}
          </Box>
        )}

        {phase.kind === 'reveal' && (
          <RevealSummary mine={phase.mine} theirs={phase.theirs} score={score} />
        )}

        {phase.kind === 'match_over' && (
          <MatchOverSummary mine={phase.mine} theirs={phase.theirs} score={score} />
        )}
      </Box>

      <Box paddingX={1}>
        <Text color="gray">esc  {phase.kind === 'match_over' ? 'return to playroom' : 'quit match'}</Text>
      </Box>
    </Box>
  );
}

function fighterLabel(phase: Phase, side: 'me' | 'you', placeholder: JakenpoyChoice | '?' | null): string {
  if (phase.kind === 'reveal' || phase.kind === 'match_over') {
    return choiceLabel(side === 'me' ? phase.mine : phase.theirs);
  }
  if (placeholder === null) return '';
  if (placeholder === '?') return '?';
  return choiceLabel(placeholder);
}

function FighterPair({
  pet, peerPet, mineLabel, theirsLabel, iLost, youLost,
}: {
  pet: PetState;
  peerPet: PetState;
  mineLabel: string;
  theirsLabel: string;
  iLost: boolean;
  youLost: boolean;
}) {
  const mineSprite = petSprite(pet);
  const peerSprite = petSprite(peerPet);
  const yourName = pet.name ?? 'motchi';
  const peerName = peerPet.name ?? 'friend';
  return (
    <Box flexDirection="row">
      <Box flexDirection="column" width={22}>
        <Text>you{iLost ? ' (unggoy)' : youLost ? ' ★' : ''}</Text>
        <Text> </Text>
        <Box flexDirection="row">
          <Box flexDirection="column">
            {mineSprite.map((line, i) => <PetSpriteLine key={i} line={line} />)}
          </Box>
          <Box marginLeft={2}><Text color={mineLabel ? 'cyan' : 'gray'}>{mineLabel || ' '}</Text></Box>
        </Box>
        <Text>{yourName}</Text>
      </Box>
      <Box flexDirection="column" width={22}>
        <Text>friend{youLost ? ' (unggoy)' : iLost ? ' ★' : ''}</Text>
        <Text> </Text>
        <Box flexDirection="row">
          <Box flexDirection="column">
            {peerSprite.map((line, i) => <PetSpriteLine key={i} line={line} />)}
          </Box>
          <Box marginLeft={2}><Text color={theirsLabel === '?' ? 'gray' : theirsLabel ? 'cyan' : 'gray'}>{theirsLabel || ' '}</Text></Box>
        </Box>
        <Text>{peerName}</Text>
      </Box>
    </Box>
  );
}

function RevealSummary({ mine, theirs, score }: { mine: JakenpoyChoice; theirs: JakenpoyChoice; score: { me: number; you: number } }) {
  const outcome = jakenpoyWinner(mine, theirs);
  let headline: string;
  let sub: string;
  if (outcome === 'tie') {
    headline = `${choiceLabel(mine)} vs ${choiceLabel(theirs)} — tie`;
    sub = 'replay the round';
  } else if (outcome === 'me') {
    headline = prettyVerdict(mine, theirs);
    sub = 'you win this round';
  } else {
    headline = prettyVerdict(theirs, mine);
    sub = 'friend wins this round';
  }
  return (
    <Box flexDirection="column">
      <Text>{headline}</Text>
      <Text color={outcome === 'me' ? 'green' : outcome === 'you' ? 'red' : 'gray'}>{sub}</Text>
      <Text> </Text>
      <Text>you {score.me}  ·  friend {score.you}</Text>
      <Text> </Text>
      <Text color="gray">press ↵ to continue</Text>
    </Box>
  );
}

function MatchOverSummary({ mine, theirs, score }: { mine: JakenpoyChoice; theirs: JakenpoyChoice; score: { me: number; you: number } }) {
  const iWon = score.me > score.you;
  return (
    <Box flexDirection="column">
      <Text>{iWon ? `you win ${score.me}-${score.you}` : `friend wins ${score.you}-${score.me}`}</Text>
      <Text color="gray">sinong matalo, siyang unggoy</Text>
      <Text> </Text>
      <Text color="gray">final picks: you {choiceLabel(mine)} · friend {choiceLabel(theirs)}</Text>
      <Text> </Text>
      <Text color="gray">press ↵ to return to playroom</Text>
    </Box>
  );
}
