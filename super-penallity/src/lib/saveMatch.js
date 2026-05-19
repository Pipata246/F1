// Сохранение результата матча в БД через action 'recordMatch'.
// Защищено флагом matchSavedRef.current от двойной отправки. При сетевой ошибке снимаем
// флаг, чтобы можно было повторить попытку (например, по watchdog'у).
//
// Вызывается из handleServerMessage в case 'match_result' — только для PvP режима.
// Demo-bot не сохраняется (нет ставок и реальных игроков).
export function saveMatchToBackend({
  youWon,
  finalScores,
  finalHistory,
  matchSavedRef,
  initData,
  displayName,
  opponent,
  opponentTgId,
  opponentIsBot,
  suddenDeath,
}) {
  if (matchSavedRef.current || !initData) return;
  matchSavedRef.current = true;
  const tgUserId = window.Telegram?.WebApp?.initDataUnsafe?.user?.id?.toString() || null;
  fetch('/api/user', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'recordMatch',
      initData,
      payload: {
        gameKey: 'super_penalty',
        mode: 'pvp',
        winnerTgUserId: youWon ? tgUserId : null,
        players: [
          { tgUserId, name: displayName || 'Player', score: finalScores?.[0] || 0, isWinner: !!youWon, isBot: false },
          { tgUserId: opponentTgId || null, name: opponent || 'Opponent', score: finalScores?.[1] || 0, isWinner: !youWon, isBot: !!opponentIsBot },
        ],
        score: { left: finalScores?.[0] || 0, right: finalScores?.[1] || 0 },
        details: { roundsPlayed: finalHistory?.length || 0, suddenDeath },
      },
    }),
  }).catch(() => { matchSavedRef.current = false; });
}
