use std::collections::HashSet;

use checkbook_domain::{MembershipRole, OwnershipScope, RelationshipKind};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModuleName {
    Planning,
    Settings,
    Imports,
    Records,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModuleAction {
    Read,
    Write,
    Delete,
}

#[derive(Debug, Clone, Copy)]
pub struct AccessContext {
    pub role: MembershipRole,
    pub relationship: RelationshipKind,
    pub allow_cross_member_visibility: bool,
}

#[must_use]
pub fn allowed_scopes(context: AccessContext) -> HashSet<OwnershipScope> {
    if context.role == MembershipRole::Owner || context.allow_cross_member_visibility {
        return [
            OwnershipScope::SelfOwned,
            OwnershipScope::Spouse,
            OwnershipScope::Joint,
        ]
        .into_iter()
        .collect();
    }

    match context.relationship {
        RelationshipKind::Owner => [OwnershipScope::SelfOwned, OwnershipScope::Joint]
            .into_iter()
            .collect(),
        RelationshipKind::Spouse => [OwnershipScope::Spouse, OwnershipScope::Joint]
            .into_iter()
            .collect(),
        RelationshipKind::Member => [OwnershipScope::Joint].into_iter().collect(),
    }
}

#[cfg(test)]
mod tests {
    use checkbook_domain::{MembershipRole, OwnershipScope, RelationshipKind};

    use super::{AccessContext, allowed_scopes};

    #[test]
    fn contributor_scope_matches_existing_contract() {
        let scopes = allowed_scopes(AccessContext {
            role: MembershipRole::Contributor,
            relationship: RelationshipKind::Spouse,
            allow_cross_member_visibility: false,
        });
        assert_eq!(
            scopes,
            [OwnershipScope::Spouse, OwnershipScope::Joint]
                .into_iter()
                .collect()
        );
    }

    #[test]
    fn ordinary_members_can_access_only_joint_rows() {
        let scopes = allowed_scopes(AccessContext {
            role: MembershipRole::Contributor,
            relationship: RelationshipKind::Member,
            allow_cross_member_visibility: false,
        });
        assert_eq!(scopes, [OwnershipScope::Joint].into_iter().collect());
    }
}
