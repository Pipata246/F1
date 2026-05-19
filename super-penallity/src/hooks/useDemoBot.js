import { useCallback } from 'react';

const MAX_ROUNDS = 5;
const MAX_MOVES = 10; // 5 раундов × 2 хода

// Локальная игра с ботом (без бэкенда, без ставок). Использует тот же handleServerMessage
// что и PvP — round_result/round_start/match_result — но без сетевого слоя. Бот делает
// случайный ход через 100 мс.
//
// Отделено от PvP-submit, потому что не нужен retry/watchdog/turnId/applyPvpRoomState.
// Использует свои локальные снэпшоты round/scores/history/suddenDeath (передаются getter'ами,
// чтобы не пересоздавать chooseDemoZone при каждом изменении state).
export function useDemoBot({
  // refs
  lastSubmittedZoneRef,
  selectedZoneRef,
  // setters
  setSelectedZone,
  setZoneLocked,
  setWaitingOpponent,
  setSuddenDeathStartRound,
  // callbacks
  stopTimer,
  handleServerMessage,
  // snapshot-getter'ы текущего game state (round/scores/history/suddenDeath/suddenDeathStartRound)
  getDemoSnapshot,
}) {
  const chooseDemoZone = useCallback((zoneRaw) => {
    const playerZone = Number(zoneRaw);
    if (![0, 1, 2, 3].includes(playerZone)) return;

    // Atomic anti-duplicate через ref (как в PvP-ветке).
    if (lastSubmittedZoneRef.current !== null && lastSubmittedZoneRef.current !== undefined) return;
    lastSubmittedZoneRef.current = playerZone;
    if (selectedZoneRef.current === null || selectedZoneRef.current === undefined) {
      selectedZoneRef.current = playerZone;
      setSelectedZone(playerZone);
    }

    setZoneLocked(true);
    setWaitingOpponent(true);
    stopTimer();

    // Бот делает случайный ход мгновенно.
    setTimeout(() => {
      const botZone = Math.floor(Math.random() * 4);
      const { round, scores, history, suddenDeath, suddenDeathStartRound } = getDemoSnapshot();

      const currentRound = round;
      const kickerIndex = (currentRound - 1) % 2 === 0 ? 0 : 1;
      const keeperIndex = 1 - kickerIndex;

      const kickerZone = kickerIndex === 0 ? playerZone : botZone;
      const keeperZone = keeperIndex === 0 ? playerZone : botZone;
      const isGoal = kickerZone !== keeperZone;

      const newScores = [...scores];
      if (isGoal) newScores[kickerIndex]++;

      const newHistory = [...history, { kickerIndex, kickerZone, keeperZone, isGoal }];

      // Проверяем по количеству ходов в истории, а не по номеру раунда.
      const totalMoves = newHistory.length;

      let needsOvertime = false;
      let startingSuddenDeath = false;
      let overtimeStartRound = suddenDeathStartRound;

      if (totalMoves >= MAX_MOVES && !suddenDeath) {
        if (newScores[0] === newScores[1]) {
          needsOvertime = true;
          startingSuddenDeath = true;
          overtimeStartRound = totalMoves;
        }
      }

      // Проверяем конец овертайма (кто-то забил больше в текущем цикле).
      let gameEnded = false;
      if (suddenDeath && totalMoves > MAX_MOVES) {
        const overtimeMoves = totalMoves - suddenDeathStartRound;
        if (overtimeMoves % 2 === 0) {
          const lastTwoMoves = newHistory.slice(-2);
          const p1Goals = lastTwoMoves.filter((h) => h.kickerIndex === 0 && h.isGoal).length;
          const p2Goals = lastTwoMoves.filter((h) => h.kickerIndex === 1 && h.isGoal).length;
          if (p1Goals !== p2Goals) gameEnded = true;
        }
      }

      // gameOver передаётся для watchdog'а в handleRoundResult — на случай если
      // setTimeout match_result потерялся.
      const endsBasic = (totalMoves >= MAX_MOVES && !needsOvertime && !suddenDeath);
      const gameOverFlag = endsBasic || gameEnded;
      handleServerMessage({
        type: 'round_result',
        kickerZone,
        keeperZone,
        isGoal,
        scores: newScores,
        round: currentRound,
        kickerIndex,
        history: newHistory,
        startSuddenDeath: startingSuddenDeath,
        gameOver: gameOverFlag,
        winnerSide: gameOverFlag ? (newScores[0] > newScores[1] ? 'p1' : 'p2') : null,
        mySide: 'p1', // в demo игрок всегда p1
      });

      if (startingSuddenDeath) {
        setTimeout(() => setSuddenDeathStartRound(overtimeStartRound), 100);
      }

      if (totalMoves >= MAX_MOVES && !needsOvertime && !suddenDeath) {
        // Основная игра закончена.
        setTimeout(() => {
          const youWon = newScores[0] > newScores[1];
          handleServerMessage({ type: 'match_result', youWon, scores: newScores });
        }, 1500);
      } else if (gameEnded) {
        // Овертайм закончен.
        setTimeout(() => {
          const youWon = newScores[0] > newScores[1];
          handleServerMessage({ type: 'match_result', youWon, scores: newScores });
        }, 1500);
      } else {
        // Следующий раунд.
        setTimeout(() => {
          const nextRound = currentRound + 1;
          const nextKickerIndex = (nextRound - 1) % 2 === 0 ? 0 : 1;
          const inSuddenDeath = needsOvertime || suddenDeath;

          handleServerMessage({
            type: 'round_start',
            round: nextRound,
            maxRounds: inSuddenDeath ? nextRound : MAX_ROUNDS,
            role: nextKickerIndex === 0 ? 'kicker' : 'keeper',
            scores: newScores,
            suddenDeath: inSuddenDeath,
            history: newHistory,
          });
        }, startingSuddenDeath ? 4000 : 1500); // Больше времени если показываем овертайм
      }
    }, 100); // Минимальная задержка для плавности UI
  }, [
    lastSubmittedZoneRef, selectedZoneRef, setSelectedZone,
    setZoneLocked, setWaitingOpponent, setSuddenDeathStartRound,
    stopTimer, handleServerMessage, getDemoSnapshot,
  ]);

  return { chooseDemoZone };
}
