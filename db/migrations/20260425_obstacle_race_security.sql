-- Security fixes for Obstacle Race: Filtered state function to prevent cheating

-- Function to get filtered room state for Obstacle Race (hides opponent's traps and moves)
CREATE OR REPLACE FUNCTION public.pvp_get_filtered_obstacle_state(
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
  v_phase text;
  v_traps jsonb;
  v_pending jsonb;
  v_overtime_traps jsonb;
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
  v_phase := v_state->>'phase';
  
  -- Determine player side
  IF v_room.player1_tg_user_id = p_tg_user_id THEN
    v_side := 'p1';
  ELSE
    v_side := 'p2';
  END IF;
  
  -- Filter traps during placing phase
  IF v_phase = 'placing_traps' THEN
    v_traps := coalesce(v_state->'traps', '{}'::jsonb);
    
    -- Player only sees their own traps during placement
    IF v_side = 'p1' THEN
      v_traps := jsonb_build_object(
        'p1', coalesce(v_traps->'p1', 'null'::jsonb),
        'p2', 'null'::jsonb
      );
    ELSE
      v_traps := jsonb_build_object(
        'p1', 'null'::jsonb,
        'p2', coalesce(v_traps->'p2', 'null'::jsonb)
      );
    END IF;
    
    v_state := jsonb_set(v_state, '{traps}', v_traps);
  END IF;
  
  -- Filter overtime traps during overtime_placing phase
  IF v_phase = 'overtime_placing' THEN
    v_overtime_traps := coalesce(v_state->'overtimeTraps', '{}'::jsonb);
    
    -- Player only sees their own overtime traps during placement
    IF v_side = 'p1' THEN
      v_overtime_traps := jsonb_build_object(
        'p1', coalesce(v_overtime_traps->'p1', 'null'::jsonb),
        'p2', 'null'::jsonb
      );
    ELSE
      v_overtime_traps := jsonb_build_object(
        'p1', 'null'::jsonb,
        'p2', coalesce(v_overtime_traps->'p2', 'null'::jsonb)
      );
    END IF;
    
    v_state := jsonb_set(v_state, '{overtimeTraps}', v_overtime_traps);
  END IF;
  
  -- Filter pending moves during running phase
  IF v_phase = 'running' THEN
    v_pending := coalesce(v_state->'pendingMoves', '{}'::jsonb);
    
    -- Player only sees their own pending move
    IF v_side = 'p1' THEN
      v_pending := jsonb_build_object(
        'p1', coalesce(v_pending->'p1', 'null'::jsonb),
        'p2', 'null'::jsonb
      );
    ELSE
      v_pending := jsonb_build_object(
        'p1', 'null'::jsonb,
        'p2', coalesce(v_pending->'p2', 'null'::jsonb)
      );
    END IF;
    
    v_state := jsonb_set(v_state, '{pendingMoves}', v_pending);
  END IF;
  
  RETURN v_state;
END;
$$;
