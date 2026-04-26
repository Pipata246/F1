-- Security fixes for Frog Hunt: RLS policies to prevent cheating

-- Enable RLS on pvp_rooms table
ALTER TABLE public.pvp_rooms ENABLE ROW LEVEL SECURITY;

-- Policy: Players can only read their own rooms
DROP POLICY IF EXISTS pvp_rooms_players_read ON public.pvp_rooms;
CREATE POLICY pvp_rooms_players_read 
  ON public.pvp_rooms 
  FOR SELECT 
  USING (
    -- Allow service role full access
    auth.role() = 'service_role'
    OR
    -- Players can only see rooms they're in
    player1_tg_user_id = current_setting('app.current_user_tg_id', true)
    OR player2_tg_user_id = current_setting('app.current_user_tg_id', true)
  );

-- Policy: Only service role can insert/update/delete
DROP POLICY IF EXISTS pvp_rooms_service_only ON public.pvp_rooms;
CREATE POLICY pvp_rooms_service_only 
  ON public.pvp_rooms 
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- Function to get filtered room state (hides opponent's pending move)
CREATE OR REPLACE FUNCTION public.pvp_get_filtered_room_state(
  p_room_id bigint,
  p_tg_user_id text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_room public.pvp_rooms%rowtype;
  v_state jsonb;
  v_side text;
  v_game_key text;
BEGIN
  -- Get room
  SELECT * INTO v_room FROM public.pvp_rooms WHERE id = p_room_id;
  
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Room not found';
  END IF;
  
  -- Check player is in this room
  IF v_room.player1_tg_user_id <> p_tg_user_id 
     AND v_room.player2_tg_user_id <> p_tg_user_id THEN
    RAISE EXCEPTION 'Access denied';
  END IF;
  
  v_state := coalesce(v_room.state_json, '{}'::jsonb);
  v_game_key := coalesce(v_room.game_key, '');
  
  -- Determine player side
  IF v_room.player1_tg_user_id = p_tg_user_id THEN
    v_side := 'p1';
  ELSE
    v_side := 'p2';
  END IF;
  
  -- Filter data based on game type
  IF v_game_key = 'frog_hunt' THEN
    -- Frog Hunt filtering (existing logic)
    DECLARE
      v_my_role text;
      v_pending jsonb;
    BEGIN
      v_my_role := v_state->'roles'->>v_side;
      
      IF (v_state->>'phase') = 'turn_input' THEN
        v_pending := coalesce(v_state->'pending', '{}'::jsonb);
        
        IF v_my_role = 'hunter' THEN
          -- Hunter should NOT see frog's cell until round resolves
          v_pending := jsonb_build_object(
            'frogCell', null,
            'hunterCells', coalesce(v_pending->'hunterCells', '[]'::jsonb)
          );
        ELSIF v_my_role = 'frog' THEN
          -- Frog should NOT see hunter's cells until round resolves
          v_pending := jsonb_build_object(
            'frogCell', v_pending->'frogCell',
            'hunterCells', '[]'::jsonb
          );
        END IF;
        
        v_state := jsonb_set(v_state, '{pending}', v_pending);
      END IF;
    END;
    
  ELSIF v_game_key = 'obstacle_race' THEN
    -- Obstacle Race filtering
    DECLARE
      v_opponent_side text;
      v_phase text;
      v_traps jsonb;
      v_overtime_traps jsonb;
      v_pending_moves jsonb;
    BEGIN
      v_opponent_side := CASE WHEN v_side = 'p1' THEN 'p2' ELSE 'p1' END;
      v_phase := coalesce(v_state->>'phase', '');
      
      -- Hide opponent's traps during placement phase
      IF v_phase = 'placing_traps' THEN
        v_traps := coalesce(v_state->'traps', '{}'::jsonb);
        -- Remove opponent's traps, keep only my traps
        v_traps := jsonb_build_object(
          v_side, coalesce(v_traps->v_side, 'null'::jsonb),
          v_opponent_side, 'null'::jsonb
        );
        v_state := jsonb_set(v_state, '{traps}', v_traps);
      END IF;
      
      -- Hide opponent's overtime traps during overtime placement
      IF v_phase = 'overtime_placing' THEN
        v_overtime_traps := coalesce(v_state->'overtimeTraps', '{}'::jsonb);
        -- Remove opponent's overtime traps, keep only my traps
        v_overtime_traps := jsonb_build_object(
          v_side, coalesce(v_overtime_traps->v_side, 'null'::jsonb),
          v_opponent_side, 'null'::jsonb
        );
        v_state := jsonb_set(v_state, '{overtimeTraps}', v_overtime_traps);
      END IF;
      
      -- Hide opponent's pending moves during running phase
      IF v_phase = 'running' THEN
        v_pending_moves := coalesce(v_state->'pendingMoves', '{}'::jsonb);
        -- Remove opponent's pending move, keep only my move
        v_pending_moves := jsonb_build_object(
          v_side, coalesce(v_pending_moves->v_side, 'null'::jsonb),
          v_opponent_side, 'null'::jsonb
        );
        v_state := jsonb_set(v_state, '{pendingMoves}', v_pending_moves);
      END IF;
    END;
  END IF;
  
  RETURN v_state;
END;
$$;
