-- DESTRUCTIVE RESET: run only in the dedicated Pinokio Supabase project.
-- Deletes Pinokio comments, teams, profiles, invite codes and ALL auth users
-- in this Supabase project. OAuth provider settings and API keys are unchanged.
-- Run the entire file as one SQL Editor execution; repeat it only to reset again.
BEGIN;

DROP FUNCTION IF EXISTS public.pinokio_request_join(text,text);
DROP FUNCTION IF EXISTS public.pinokio_decide_request(uuid,text);
DROP SCHEMA IF EXISTS pinokio_private CASCADE;
DROP TABLE IF EXISTS public.comments, public.team_requests, public.team_members,
  public.teams, public.users CASCADE;
DELETE FROM auth.users;

-- Create users table
CREATE TABLE users (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    display_name TEXT NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 80),
    avatar_url TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Create teams table
CREATE TABLE teams (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    team_code TEXT UNIQUE NOT NULL DEFAULT upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 20)) CHECK (team_code ~ '^[A-F0-9]{20}$'),
    admin_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    origin TEXT NOT NULL CHECK (origin ~ '^https?://[^/]+$'),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Create team_requests table (for the Lobby system)
CREATE TABLE team_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    UNIQUE(team_id, user_id)
);

-- Create team_members table
CREATE TABLE team_members (
    team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    joined_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    PRIMARY KEY (team_id, user_id)
);

-- Create comments table
CREATE TABLE comments (
    id TEXT PRIMARY KEY, -- The unique ID generated locally
    team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    selector TEXT NOT NULL,
    comment TEXT NOT NULL,
    fallback_selectors JSONB,
    text_content_fallback JSONB,
    active_nav_label TEXT,
    active_nav_index INTEGER,
    active_nav_group_size INTEGER,
    active_nav_group_position TEXT,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL
);

ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.teams ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.team_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.team_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.comments ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.users, public.teams, public.team_requests, public.team_members, public.comments FROM anon, authenticated;
GRANT SELECT, INSERT(id, display_name, avatar_url), UPDATE(display_name, avatar_url) ON public.users TO authenticated;
GRANT SELECT, INSERT(admin_id, origin) ON public.teams TO authenticated;
GRANT SELECT, INSERT(team_id, user_id) ON public.team_members TO authenticated;
GRANT SELECT ON public.team_requests TO authenticated;
GRANT SELECT, INSERT(id, team_id, user_id, url, selector, comment, fallback_selectors, text_content_fallback, active_nav_label, active_nav_index, active_nav_group_size, active_nav_group_position, created_at),
  UPDATE(url, selector, comment, fallback_selectors, text_content_fallback, active_nav_label, active_nav_index, active_nav_group_size, active_nav_group_position), DELETE ON public.comments TO authenticated;

CREATE SCHEMA IF NOT EXISTS pinokio_private;
REVOKE ALL ON SCHEMA pinokio_private FROM PUBLIC, anon;
GRANT USAGE ON SCHEMA pinokio_private TO authenticated;

CREATE OR REPLACE FUNCTION pinokio_private.is_oauth_user()
RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
  SELECT auth.uid() IS NOT NULL
    AND (auth.jwt()->>'is_anonymous')::boolean IS FALSE
    AND coalesce(auth.jwt()->'app_metadata'->>'provider' IN ('google', 'github'), false);
$$;
CREATE OR REPLACE FUNCTION pinokio_private.is_member(p_team uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT pinokio_private.is_oauth_user() AND EXISTS
    (SELECT 1 FROM public.team_members m WHERE m.team_id = p_team AND m.user_id = (SELECT auth.uid()));
$$;
CREATE OR REPLACE FUNCTION pinokio_private.is_admin(p_team uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT pinokio_private.is_oauth_user() AND EXISTS
    (SELECT 1 FROM public.teams t WHERE t.id = p_team AND t.admin_id = (SELECT auth.uid()));
$$;
CREATE OR REPLACE FUNCTION pinokio_private.can_read_user(p_user uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT pinokio_private.is_oauth_user() AND
    (p_user = (SELECT auth.uid())
    OR EXISTS (SELECT 1 FROM public.team_members other_member
      JOIN public.team_members my_member ON my_member.team_id = other_member.team_id
      WHERE other_member.user_id = p_user AND my_member.user_id = (SELECT auth.uid()))
    OR EXISTS (SELECT 1 FROM public.team_requests r JOIN public.teams t ON t.id = r.team_id
      WHERE r.user_id = p_user AND t.admin_id = (SELECT auth.uid())));
$$;

-- Anonymous Auth users also have the authenticated database role. A restrictive
-- policy keeps this gate in force alongside every row-level permission below.
-- Only Google and GitHub OAuth accounts may read or write Pinokio data.
CREATE POLICY "pinokio_oauth_only" ON public.users AS RESTRICTIVE FOR ALL TO authenticated
  USING (pinokio_private.is_oauth_user()) WITH CHECK (pinokio_private.is_oauth_user());
CREATE POLICY "pinokio_oauth_only" ON public.teams AS RESTRICTIVE FOR ALL TO authenticated
  USING (pinokio_private.is_oauth_user()) WITH CHECK (pinokio_private.is_oauth_user());
CREATE POLICY "pinokio_oauth_only" ON public.team_requests AS RESTRICTIVE FOR ALL TO authenticated
  USING (pinokio_private.is_oauth_user()) WITH CHECK (pinokio_private.is_oauth_user());
CREATE POLICY "pinokio_oauth_only" ON public.team_members AS RESTRICTIVE FOR ALL TO authenticated
  USING (pinokio_private.is_oauth_user()) WITH CHECK (pinokio_private.is_oauth_user());
CREATE POLICY "pinokio_oauth_only" ON public.comments AS RESTRICTIVE FOR ALL TO authenticated
  USING (pinokio_private.is_oauth_user()) WITH CHECK (pinokio_private.is_oauth_user());

CREATE POLICY "pinokio_users_read" ON public.users FOR SELECT TO authenticated USING (pinokio_private.can_read_user(id));
CREATE POLICY "pinokio_users_insert" ON public.users FOR INSERT TO authenticated WITH CHECK (id = (SELECT auth.uid()));
CREATE POLICY "pinokio_users_update" ON public.users FOR UPDATE TO authenticated USING (id = (SELECT auth.uid())) WITH CHECK (id = (SELECT auth.uid()));
CREATE POLICY "pinokio_teams_read" ON public.teams FOR SELECT TO authenticated
  USING (admin_id = (SELECT auth.uid()) OR pinokio_private.is_member(id)
    OR EXISTS (SELECT 1 FROM public.team_requests r WHERE r.team_id = id AND r.user_id = (SELECT auth.uid())));
CREATE POLICY "pinokio_teams_insert" ON public.teams FOR INSERT TO authenticated
  WITH CHECK (admin_id = (SELECT auth.uid()) AND origin ~ '^https?://[^/]+$');
CREATE POLICY "pinokio_members_read" ON public.team_members FOR SELECT TO authenticated
  USING (pinokio_private.is_member(team_id) OR pinokio_private.is_admin(team_id));
CREATE POLICY "pinokio_members_insert" ON public.team_members FOR INSERT TO authenticated
  WITH CHECK (pinokio_private.is_admin(team_id));
CREATE POLICY "pinokio_requests_read" ON public.team_requests FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()) OR pinokio_private.is_admin(team_id));
CREATE POLICY "pinokio_comments_read" ON public.comments FOR SELECT TO authenticated
  USING (pinokio_private.is_member(team_id));
CREATE POLICY "pinokio_comments_insert" ON public.comments FOR INSERT TO authenticated
  WITH CHECK (user_id = (SELECT auth.uid()) AND pinokio_private.is_member(team_id)
    AND EXISTS (SELECT 1 FROM public.teams t WHERE t.id = team_id AND left(url, length(t.origin) + 1) = t.origin || '/'));
CREATE POLICY "pinokio_comments_update" ON public.comments FOR UPDATE TO authenticated
  USING (user_id = (SELECT auth.uid()) AND pinokio_private.is_member(team_id))
  WITH CHECK (user_id = (SELECT auth.uid()) AND pinokio_private.is_member(team_id)
    AND EXISTS (SELECT 1 FROM public.teams t WHERE t.id = team_id AND left(url, length(t.origin) + 1) = t.origin || '/'));
CREATE POLICY "pinokio_comments_delete" ON public.comments FOR DELETE TO authenticated
  USING (pinokio_private.is_member(team_id) AND (user_id = (SELECT auth.uid()) OR pinokio_private.is_admin(team_id)));

-- Public RPCs are invoker-only; privileged work lives in a non-exposed schema.
CREATE OR REPLACE FUNCTION pinokio_private.request_join(p_code text, p_origin text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE t public.teams%ROWTYPE; r public.team_requests%ROWTYPE;
BEGIN
  IF NOT pinokio_private.is_oauth_user() OR p_code !~ '^[A-Fa-f0-9]{20}$' THEN RETURN NULL; END IF;
  SELECT * INTO t FROM public.teams WHERE team_code = upper(p_code) AND origin = p_origin;
  IF NOT FOUND THEN RETURN NULL; END IF;
  INSERT INTO public.team_requests(team_id, user_id, status)
    VALUES (t.id, auth.uid(), 'pending') ON CONFLICT (team_id, user_id) DO NOTHING;
  SELECT * INTO r FROM public.team_requests WHERE team_id = t.id AND user_id = auth.uid();
  RETURN jsonb_build_object('team', jsonb_build_object('id', t.id, 'team_code', t.team_code, 'admin_id', t.admin_id, 'origin', t.origin), 'status', r.status);
END;
$$;
CREATE OR REPLACE FUNCTION public.pinokio_request_join(p_code text, p_origin text)
RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path = '' AS $$
  SELECT pinokio_private.request_join(p_code, p_origin);
$$;
CREATE OR REPLACE FUNCTION pinokio_private.decide_request(p_request_id uuid, p_status text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.team_requests%ROWTYPE;
BEGIN
  IF NOT pinokio_private.is_oauth_user() OR p_status NOT IN ('approved', 'rejected') THEN RETURN false; END IF;
  SELECT * INTO r FROM public.team_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND OR r.status <> 'pending' OR NOT pinokio_private.is_admin(r.team_id) THEN RETURN false; END IF;
  IF p_status = 'approved' THEN
    INSERT INTO public.team_members(team_id, user_id) VALUES (r.team_id, r.user_id) ON CONFLICT DO NOTHING;
  END IF;
  UPDATE public.team_requests SET status = p_status WHERE id = p_request_id;
  RETURN true;
END;
$$;
CREATE OR REPLACE FUNCTION public.pinokio_decide_request(p_request_id uuid, p_status text)
RETURNS boolean LANGUAGE sql SECURITY INVOKER SET search_path = '' AS $$
  SELECT pinokio_private.decide_request(p_request_id, p_status);
$$;

REVOKE ALL ON FUNCTION pinokio_private.is_oauth_user(), pinokio_private.is_member(uuid), pinokio_private.is_admin(uuid), pinokio_private.can_read_user(uuid),
  pinokio_private.request_join(text,text), pinokio_private.decide_request(uuid,text),
  public.pinokio_request_join(text,text), public.pinokio_decide_request(uuid,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pinokio_private.is_oauth_user(), pinokio_private.is_member(uuid), pinokio_private.is_admin(uuid), pinokio_private.can_read_user(uuid),
  pinokio_private.request_join(text,text), pinokio_private.decide_request(uuid,text),
  public.pinokio_request_join(text,text), public.pinokio_decide_request(uuid,text) TO authenticated;

COMMIT;
