-- ============================================
-- ROULETTE GAME TABLES
-- Created: 2026-05-08
-- Description: Tables for PvP Roulette game
-- ============================================

-- ============================================
-- 1. ROULETTE ROUNDS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS roulette_rounds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  
  -- Round status
  status TEXT NOT NULL CHECK (status IN ('waiting', 'active', 'spinning', 'finished')),
  
  -- Pot and timing
  pot_amount DECIMAL(18,9) NOT NULL DEFAULT 0,
  timer_ends_at TIMESTAMPTZ,
  
  -- Winner info (filled after spin)
  winner_user_id TEXT REFERENCES users(tg_user_id) ON DELETE SET NULL,
  winner_amount DECIMAL(18,9),
  
  -- Platform fee (configurable, default 5%)
  platform_fee_percent DECIMAL(5,2) NOT NULL DEFAULT 5.00,
  platform_fee_amount DECIMAL(18,9),
  
  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ, -- When 2nd player joined
  finished_at TIMESTAMPTZ,
  
  -- Metadata
  players_count INT NOT NULL DEFAULT 0,
  total_bets_count INT NOT NULL DEFAULT 0
);

-- Indexes for roulette_rounds
CREATE INDEX IF NOT EXISTS idx_roulette_rounds_status ON roulette_rounds(status);
CREATE INDEX IF NOT EXISTS idx_roulette_rounds_created ON roulette_rounds(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_roulette_rounds_winner ON roulette_rounds(winner_user_id) WHERE winner_user_id IS NOT NULL;

-- ============================================
-- 2. ROULETTE BETS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS roulette_bets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  
  -- References
  round_id UUID NOT NULL REFERENCES roulette_rounds(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(tg_user_id) ON DELETE CASCADE,
  
  -- Bet info
  bet_amount DECIMAL(18,9) NOT NULL CHECK (bet_amount >= 0.1),
  chance_percent DECIMAL(5,2) NOT NULL DEFAULT 0,
  
  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  
  -- Constraints
  CONSTRAINT unique_user_per_round UNIQUE(round_id, user_id)
);

-- Indexes for roulette_bets
CREATE INDEX IF NOT EXISTS idx_roulette_bets_round ON roulette_bets(round_id);
CREATE INDEX IF NOT EXISTS idx_roulette_bets_user ON roulette_bets(user_id);
CREATE INDEX IF NOT EXISTS idx_roulette_bets_created ON roulette_bets(created_at DESC);

-- ============================================
-- 3. ROULETTE RESULTS TABLE (History)
-- ============================================
CREATE TABLE IF NOT EXISTS roulette_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  
  -- References
  round_id UUID NOT NULL REFERENCES roulette_rounds(id) ON DELETE CASCADE,
  winner_user_id TEXT NOT NULL REFERENCES users(tg_user_id) ON DELETE CASCADE,
  
  -- Result info
  winner_amount DECIMAL(18,9) NOT NULL,
  total_pot DECIMAL(18,9) NOT NULL,
  platform_fee DECIMAL(18,9) NOT NULL,
  players_count INT NOT NULL,
  winner_chance_percent DECIMAL(5,2) NOT NULL,
  
  -- Winner details (denormalized for history)
  winner_display_name TEXT,
  winner_bet_amount DECIMAL(18,9) NOT NULL,
  
  -- Timestamp
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  
  -- Constraints
  CONSTRAINT unique_result_per_round UNIQUE(round_id)
);

-- Indexes for roulette_results
CREATE INDEX IF NOT EXISTS idx_roulette_results_winner ON roulette_results(winner_user_id);
CREATE INDEX IF NOT EXISTS idx_roulette_results_created ON roulette_results(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_roulette_results_round ON roulette_results(round_id);

-- ============================================
-- 4. HELPER FUNCTIONS
-- ============================================

-- Function to update bet timestamp
CREATE OR REPLACE FUNCTION update_roulette_bet_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger for updating bet timestamp
DROP TRIGGER IF EXISTS trigger_update_roulette_bet_timestamp ON roulette_bets;
CREATE TRIGGER trigger_update_roulette_bet_timestamp
  BEFORE UPDATE ON roulette_bets
  FOR EACH ROW
  EXECUTE FUNCTION update_roulette_bet_timestamp();

-- ============================================
-- 5. ROW LEVEL SECURITY (RLS)
-- ============================================

-- Enable RLS on all tables
ALTER TABLE roulette_rounds ENABLE ROW LEVEL SECURITY;
ALTER TABLE roulette_bets ENABLE ROW LEVEL SECURITY;
ALTER TABLE roulette_results ENABLE ROW LEVEL SECURITY;

-- Policy: Everyone can read active/finished rounds
CREATE POLICY "Anyone can view rounds"
  ON roulette_rounds
  FOR SELECT
  USING (true);

-- Policy: Everyone can read bets for active rounds
CREATE POLICY "Anyone can view bets"
  ON roulette_bets
  FOR SELECT
  USING (true);

-- Policy: Everyone can read results
CREATE POLICY "Anyone can view results"
  ON roulette_results
  FOR SELECT
  USING (true);

-- Policy: Only service role can insert/update/delete
-- (All writes go through Edge Functions with service role)
CREATE POLICY "Service role can manage rounds"
  ON roulette_rounds
  FOR ALL
  USING (auth.role() = 'service_role');

CREATE POLICY "Service role can manage bets"
  ON roulette_bets
  FOR ALL
  USING (auth.role() = 'service_role');

CREATE POLICY "Service role can manage results"
  ON roulette_results
  FOR ALL
  USING (auth.role() = 'service_role');

-- ============================================
-- 6. INITIAL DATA (Optional)
-- ============================================

-- Create first round in waiting state
-- INSERT INTO roulette_rounds (status, pot_amount, players_count)
-- VALUES ('waiting', 0, 0);

-- ============================================
-- MIGRATION COMPLETE
-- ============================================

-- Verify tables were created
DO $$
BEGIN
  RAISE NOTICE 'Roulette tables created successfully:';
  RAISE NOTICE '  - roulette_rounds';
  RAISE NOTICE '  - roulette_bets';
  RAISE NOTICE '  - roulette_results';
  RAISE NOTICE 'Indexes and RLS policies applied.';
END $$;
