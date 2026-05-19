import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { TmaTopSafe } from '../TmaTopSafe.jsx';
import { GrassSVG } from '../GrassSVG.jsx';
import { KickDots } from '../KickDots.jsx';
import { Keeper } from '../Keeper.jsx';
import { Ball } from '../Ball.jsx';
import { TargetZones } from '../TargetZones.jsx';
import { ConnectionErrorModal } from '../ConnectionErrorModal.jsx';

// Главный игровой экран: табло (счёт + dots + таймер), overlay'и роли и овертайма,
// поле с воротами / вратарём / мячом / зонами выбора, статус-текст и connection-modal.
//
// Чистая презентация — никакого useState/useEffect. Вся логика остаётся в GamePage
// через handleChooseZone / handleExitToMenu / pvpPollState callback'и.
export function GameScreen({
  // styling
  safeFrameGameStyle,
  assetBase,
  // game state
  displayName,
  opponent,
  playerIndex,
  scores,
  currentStakeTon,
  suddenDeath,
  suddenDeathStartRound,
  history,
  timer,
  role,
  zoneLocked,
  showingResult,
  inputBlocked,
  roleAnnounce,
  overtimeAnnounce,
  waitingOpponent,
  bottomNotice,
  // animation state
  ballVisible,
  ballStyle,
  keeperState,
  isKeeperMirrored,
  keeperX,
  keeperBottom,
  keeperTransitionDisabled,
  resultMessage,
  selectedZone,
  confirmedZone,
  // connection
  showConnectionError,
  setShowConnectionError,
  pvpPollInFlightRef,
  // callbacks
  handleChooseZone,
  handleExitToMenu,
  pvpPollState,
}) {
  const myScore = scores[playerIndex] ?? 0;
  const oppScore = scores[1 - playerIndex] ?? 0;

  return (
    <div className="h-screen bg-[#1a6b35] flex flex-col items-center overflow-hidden font-sans select-none relative" style={{ ...safeFrameGameStyle, contain: 'layout style paint', touchAction: 'manipulation' }}>
      <TmaTopSafe variant="grass" />
      {/* Green field gradient */}
      <div className="absolute inset-0 bg-[linear-gradient(180deg,_#145a2a_0%,_#1a6b35_30%,_#1e7a3c_60%,_#196330_100%)] pointer-events-none" />
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_50%_20%,_rgba(255,255,255,0.04),_transparent_50%)] pointer-events-none" />

      <GrassSVG />

      {/* Scoreboard */}
      <div className="z-10 w-full px-4 pt-3 mb-1">
        <div className="bg-black/40 backdrop-blur-md p-3 rounded-2xl border border-white/10 shadow-lg">
          {currentStakeTon != null && (
            <div className="text-center text-xs text-emerald-300 font-bold tracking-wider mb-2">СТАВКА: {currentStakeTon} TON</div>
          )}
          <div className="flex justify-between items-center">
            <div className="flex-1 text-center">
              <p className="text-[10px] text-blue-400 font-bold uppercase tracking-widest truncate">{displayName || 'Ты'}</p>
              <p className="text-3xl font-black text-blue-400">{myScore}</p>
            </div>
            <div className="flex flex-col items-center px-3">
              <span className="text-2xl text-white/30 font-bold">:</span>
              {suddenDeath && (
                <span className="text-[10px] text-red-400 font-bold uppercase animate-pulse">ОВЕРТАЙМ</span>
              )}
            </div>
            <div className="flex-1 text-center">
              <p className="text-[10px] text-red-400 font-bold uppercase tracking-widest truncate">{opponent}</p>
              <p className="text-3xl font-black text-red-400">{oppScore}</p>
            </div>
          </div>

          <div className="mt-2 flex flex-col items-center gap-1">
            <KickDots
              history={history}
              playerIdx={playerIndex}
              totalKicks={suddenDeath ? 1 : 5}
              label={displayName || 'Ты'}
              color="text-blue-400"
              suddenDeath={suddenDeath}
              suddenDeathStartRound={suddenDeathStartRound}
            />
            <KickDots
              history={history}
              playerIdx={1 - playerIndex}
              totalKicks={suddenDeath ? 1 : 5}
              label={opponent}
              color="text-red-400"
              suddenDeath={suddenDeath}
              suddenDeathStartRound={suddenDeathStartRound}
            />
          </div>

          <div className="flex justify-center items-center mt-2 gap-2 h-5">
            <span
              className={`text-sm font-mono font-bold ${timer <= 3 ? 'text-red-400 animate-pulse' : 'text-white/40'}`}
              style={{ visibility: (!zoneLocked && !showingResult) ? 'visible' : 'hidden' }}
            >
              {timer}с
            </span>
          </div>
        </div>
      </div>

      {/* Role announcement overlay */}
      <AnimatePresence>
        {roleAnnounce && (
          <motion.div
            key={`role-${roleAnnounce.round}`}
            initial={{ opacity: 0, y: -30 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            transition={{ duration: 0.2 }}
            className="fixed inset-0 flex items-center justify-center z-[80] pointer-events-none"
          >
            <div className={`px-10 py-5 rounded-2xl shadow-2xl text-center border-2 ${
              roleAnnounce.role === 'kicker'
                ? 'bg-black/85 border-yellow-400 shadow-yellow-500/40'
                : 'bg-black/85 border-emerald-400 shadow-emerald-500/40'
            }`}>
              <div className="text-4xl mb-2">
                {roleAnnounce.role === 'kicker' ? '⚽' : '🧤'}
              </div>
              <div className={`text-2xl font-black tracking-widest uppercase ${
                roleAnnounce.role === 'kicker' ? 'text-yellow-300' : 'text-emerald-300'
              }`}>
                {roleAnnounce.role === 'kicker' ? 'ТВОЙ УДАР!' : 'ОТБИВАЙ МЯЧ!'}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Overtime announcement overlay */}
      <AnimatePresence>
        {overtimeAnnounce && (
          <motion.div
            key="overtime-announce"
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.8 }}
            transition={{ duration: 0.3 }}
            className="fixed inset-0 flex items-center justify-center z-[80] pointer-events-none"
          >
            <div className="px-10 py-5 rounded-2xl shadow-2xl text-center border-4 bg-black/90 border-red-400 shadow-red-500/40">
              <div className="text-6xl mb-3 animate-pulse">⚡</div>
              <div className="text-4xl font-black tracking-widest uppercase text-red-400 mb-2">
                ОВЕРТАЙМ!
              </div>
              <div className="text-lg text-white/80 font-bold">
                Серия пенальти до первого гола
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Gate area + field markings */}
      <div className="relative z-10 w-[360px] h-[280px] mt-1 mx-auto flex justify-center">
        <div className="absolute bottom-[-80px] left-1/2 -translate-x-1/2 w-[280px] h-[60px] border-2 border-white/15 pointer-events-none z-0" />
        <div className="absolute bottom-[-70px] left-1/2 -translate-x-1/2 w-[8px] h-[8px] rounded-full bg-white/25 pointer-events-none z-0" />
        <motion.div
          className="relative w-full h-full"
          style={{ willChange: 'transform' }}
        >
          <img src={`${assetBase}gate.png`} alt="Gate" className="absolute inset-0 w-full h-full object-contain z-0 drop-shadow-[0_20px_50px_rgba(0,0,0,0.5)]" />
          <div className="absolute bottom-10 left-1/2 -translate-x-1/2 w-[200px] h-[40px] bg-black/40 blur-xl rounded-[100%] z-0" />

          <Keeper
            assetBase={assetBase}
            role={role}
            keeperState={keeperState}
            keeperX={keeperX}
            keeperBottom={keeperBottom}
            isKeeperMirrored={isKeeperMirrored}
            transitionDisabled={keeperTransitionDisabled}
          />

          <Ball assetBase={assetBase} visible={ballVisible} style={ballStyle} />

          <TargetZones
            role={role}
            displayedZone={confirmedZone != null ? confirmedZone : selectedZone}
            visible={!inputBlocked && !roleAnnounce && !showingResult && (role === 'kicker' || role === 'keeper')}
          />

          {/* Zone buttons */}
          <div
            className={`absolute top-0 left-4 w-[calc(100%-2rem)] h-[85%] grid grid-cols-2 grid-rows-2 z-30 ${inputBlocked || !!roleAnnounce ? 'pointer-events-none' : ''}`}
          >
            {[0, 1, 2, 3].map((zone) => (
              <button
                key={zone}
                type="button"
                tabIndex={-1}
                onClick={() => handleChooseZone(zone)}
                onMouseDown={(e) => e.preventDefault()}
                disabled={zoneLocked || showingResult || inputBlocked || !!roleAnnounce}
                className={`w-full h-full outline-none transition-colors rounded-lg ${
                  zoneLocked || showingResult ? 'cursor-default' : 'hover:bg-white/10 active:bg-white/20'
                }`}
              />
            ))}
          </div>

          {/* Result overlay */}
          <AnimatePresence>
            {resultMessage && (
              <motion.div
                initial={{ opacity: 0, scale: 0.5, y: 50 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.5 }}
                className="absolute inset-0 flex items-center justify-center z-50 pointer-events-none"
              >
                <div className="relative">
                  <h1 className={`text-7xl font-black italic tracking-tighter drop-shadow-[0_5px_5px_rgba(0,0,0,1)]
                    ${resultMessage.type === 'win'
                      ? 'text-transparent bg-clip-text bg-gradient-to-b from-[#4aff93] to-[#00b548]'
                      : 'text-transparent bg-clip-text bg-gradient-to-b from-[#ff6b6b] to-[#c90000]'
                    }`}>
                    {resultMessage.text}
                  </h1>
                  <h1 className={`absolute inset-0 text-7xl font-black italic tracking-tighter -z-10 ${resultMessage.type === 'win' ? 'text-green-900' : 'text-red-900'}`}
                    style={{ WebkitTextStroke: '2px black' }}>
                    {resultMessage.text}
                  </h1>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>
      </div>

      {/* Status text — below ball (fixed height to prevent layout jump) */}
      <div className="mt-14 z-10 h-6 flex items-center justify-center">
        {waitingOpponent && !showingResult ? (
          <div className="flex items-center gap-2">
            <div className="w-4 h-4 border-2 border-white/40 border-t-transparent rounded-full animate-spin" />
            <p className="text-white/40 text-sm font-bold">Ожидание соперника...</p>
          </div>
        ) : (!zoneLocked && !showingResult) ? (
          <p className={`text-sm font-bold tracking-[0.2em] ${
            role === 'kicker' ? 'text-yellow-400/80' : 'text-blue-300/80'
          }`}>
            {role === 'kicker' ? '⚽ Выбери куда бить' : '🧤 Выбери куда прыгать'}
          </p>
        ) : null}
      </div>

      <AnimatePresence>
        <ConnectionErrorModal
          visible={showConnectionError}
          onRetry={() => {
            setShowConnectionError(false);
            pvpPollInFlightRef.current = false;
            pvpPollState();
          }}
          onExit={() => {
            setShowConnectionError(false);
            handleExitToMenu();
          }}
        />
      </AnimatePresence>

      {!!bottomNotice && (
        <div className="fixed bottom-5 left-1/2 -translate-x-1/2 z-[9999] bg-black/90 text-white text-sm font-bold px-4 py-2 rounded-xl">
          {bottomNotice}
        </div>
      )}
    </div>
  );
}
