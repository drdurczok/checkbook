-- Identity bootstrap runs before a tenant context exists. These narrowly scoped
-- functions expose only the membership/invitation needed to establish that
-- context; all subsequent reads and writes remain protected by forced RLS.
CREATE FUNCTION app.active_membership_for_user(target_user_id uuid)
RETURNS TABLE (
    id uuid,
    household_id uuid,
    user_id uuid,
    role text,
    relationship_kind text,
    is_active boolean,
    created_at timestamptz,
    updated_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
    SELECT membership.id, membership.household_id, membership.user_id,
           membership.role, membership.relationship_kind, membership.is_active,
           membership.created_at, membership.updated_at
    FROM public.household_memberships membership
    WHERE membership.user_id = target_user_id AND membership.is_active
    ORDER BY membership.created_at
    LIMIT 1
$$;

CREATE FUNCTION app.pending_invitation_for_email(target_email text)
RETURNS TABLE (
    id uuid,
    household_id uuid,
    role text,
    relationship_kind text
)
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
    SELECT invitation.id, invitation.household_id, invitation.role,
           invitation.relationship_kind
    FROM public.household_invitations invitation
    WHERE invitation.email = lower(trim(target_email))
      AND invitation.accepted_at IS NULL
      AND invitation.expires_at > now()
    ORDER BY invitation.created_at
    LIMIT 1
    FOR UPDATE
$$;

REVOKE ALL ON FUNCTION app.active_membership_for_user(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.pending_invitation_for_email(text) FROM PUBLIC;
