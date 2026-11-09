import { Checkbox } from '../components/ui/NativeControls'
import { useEffect, useId, useState } from 'react'
import { EmptyState, SectionPanel } from '../components/panel'
import { OutlinedInput, OutlinedNativeSelect } from '../components/ui/OutlinedField'
import { api } from '../lib/api'
import { useSettingsQuery } from '../features/settings/queries'
import { fmtDate } from '../lib/format'
import { useSession } from '../lib/session'
import type { HouseholdSettings, Invitation } from '../types'

export function SettingsPage() {
  const { token, setError, setMessage } = useSession()
  const fieldId = useId()
  const [busy, setBusy] = useState<string | null>(null)
  const [settings, setSettings] = useState<HouseholdSettings | null>(null)
  const [invites, setInvites] = useState<Invitation[]>([])
  const [invite, setInvite] = useState({
    email: '',
    role: 'contributor',
    relationship_kind: 'spouse',
  })
  const [settingsForm, setSettingsForm] = useState({
    privacy_mode: 'private_joint',
    allow_cross_member_visibility: false,
    projection_baseline_window_months: 6,
    projection_horizon_months: 18,
    savings_allocation_strategy: 'keep_cash_positive',
  })

  const settingsQuery = useSettingsQuery(token)

  useEffect(() => {
    if (settingsQuery.data) {
      const { settings: nextSettings, invitations: nextInvites } = settingsQuery.data
      setSettings(nextSettings)
      setInvites(nextInvites)
      setSettingsForm({
        privacy_mode: nextSettings.privacy_mode,
        allow_cross_member_visibility:
          nextSettings.allow_cross_member_visibility,
        projection_baseline_window_months:
          nextSettings.projection_baseline_window_months,
        projection_horizon_months: nextSettings.projection_horizon_months,
        savings_allocation_strategy: nextSettings.savings_allocation_strategy,
      })
    }
  }, [settingsQuery.data])

  useEffect(() => {
    if (settingsQuery.error) {
      setError(settingsQuery.error instanceof Error ? settingsQuery.error.message : 'Failed to refresh workspace.')
    }
  }, [settingsQuery.error, setError])

  async function saveSettings() {
    if (!token) {
      return
    }
    setBusy('settings')
    try {
      const next = await api.updateSettings(token, settingsForm)
      setSettings(next)
      await settingsQuery.refetch()
      setMessage('Settings saved.')
    } catch (nextError) {
      setError(
        nextError instanceof Error
          ? nextError.message
          : 'Settings save failed.',
      )
    } finally {
      setBusy(null)
    }
  }

  async function createInvite() {
    if (!token) {
      return
    }
    setBusy('invite')
    try {
      await api.createInvitation(token, invite)
      setInvites(await api.getInvitations(token))
      setInvite({ email: '', role: 'contributor', relationship_kind: 'spouse' })
      setMessage('Invitation created.')
    } catch (nextError) {
      setError(
        nextError instanceof Error ? nextError.message : 'Invitation failed.',
      )
    } finally {
      setBusy(null)
    }
  }

  if (!settings) {
    return null
  }

  return (
    <div className="page-stack">
      <div className="grid grid--two">
        <SectionPanel
          title="Household settings"
          eyebrow="Privacy and projection defaults"
        >
          <div className="form-stack">
            <div className="form-grid">
              <OutlinedNativeSelect
                id={`${fieldId}-privacy-mode`}
                label="Privacy mode"
                value={settingsForm.privacy_mode}
                onChange={(event) =>
                  setSettingsForm({
                    ...settingsForm,
                    privacy_mode: event.target.value,
                  })
                }
              >
                <option value="private_joint">Private + joint</option>
                <option value="shared_household">Shared household</option>
              </OutlinedNativeSelect>

              <OutlinedInput
                id={`${fieldId}-baseline-window`}
                label="Baseline window (months)"
                type="number"
                min="1"
                value={settingsForm.projection_baseline_window_months}
                onChange={(event) =>
                  setSettingsForm({
                    ...settingsForm,
                    projection_baseline_window_months: Number(
                      event.target.value,
                    ),
                  })
                }
              />

              <OutlinedInput
                id={`${fieldId}-projection-horizon`}
                label="Projection horizon (months)"
                type="number"
                min="1"
                value={settingsForm.projection_horizon_months}
                onChange={(event) =>
                  setSettingsForm({
                    ...settingsForm,
                    projection_horizon_months: Number(event.target.value),
                  })
                }
              />

              <OutlinedNativeSelect
                id={`${fieldId}-savings-strategy`}
                label="Savings allocation strategy"
                value={settingsForm.savings_allocation_strategy}
                onChange={(event) =>
                  setSettingsForm({
                    ...settingsForm,
                    savings_allocation_strategy: event.target.value,
                  })
                }
              >
                <option value="keep_cash_positive">Keep cash positive</option>
                <option value="balance_goals">Balance goals</option>
              </OutlinedNativeSelect>
            </div>

            <label className="checkbox">
              <span>Allow cross-member visibility</span>
              <Checkbox

                checked={settingsForm.allow_cross_member_visibility}
                onChange={(event) =>
                  setSettingsForm({
                    ...settingsForm,
                    allow_cross_member_visibility: event.target.checked,
                  })
                }
              />
            </label>

            <button className="button" onClick={() => void saveSettings()}>
              {busy === 'settings' ? 'Saving...' : 'Save settings'}
            </button>
          </div>
        </SectionPanel>

        <SectionPanel title="Invitations" eyebrow="Household members">
          <div className="form-stack">
            <div className="form-grid">
              <OutlinedInput
                id={`${fieldId}-invite-email`}
                label="Email"
                value={invite.email}
                onChange={(event) =>
                  setInvite({ ...invite, email: event.target.value })
                }
                placeholder="spouse@example.com"
              />
              <OutlinedNativeSelect
                id={`${fieldId}-invite-role`}
                label="Role"
                value={invite.role}
                onChange={(event) =>
                  setInvite({ ...invite, role: event.target.value })
                }
              >
                <option value="contributor">Contributor</option>
                <option value="owner">Owner</option>
              </OutlinedNativeSelect>
              <OutlinedNativeSelect
                id={`${fieldId}-invite-relationship`}
                label="Relationship"
                value={invite.relationship_kind}
                onChange={(event) =>
                  setInvite({
                    ...invite,
                    relationship_kind: event.target.value,
                  })
                }
              >
                <option value="spouse">Spouse</option>
                <option value="member">Member</option>
              </OutlinedNativeSelect>
            </div>

            <button className="button" onClick={() => void createInvite()}>
              {busy === 'invite' ? 'Sending...' : 'Create invite'}
            </button>
          </div>

          {invites.length ? (
            <div className="list">
              {invites.map((item) => (
                <div className="list-row" key={item.id}>
                  <div>
                    <strong>{item.email}</strong>
                    <span>
                      {item.role} - {item.relationship_kind} -{' '}
                      {item.accepted_at ? 'Accepted' : 'Pending'}
                    </span>
                  </div>
                  <span>{fmtDate(item.created_at)}</span>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState
              title="No invitations"
              body="Create an invite to share the household workspace."
            />
          )}
        </SectionPanel>
      </div>

      <SectionPanel title="Role permissions" eyebrow="Effective access rules">
        <div className="permission-grid">
          {Object.entries(settings.role_permissions ?? {}).map(
            ([moduleName, roleMap]) => (
              <div className="list-row" key={moduleName}>
                <div>
                  <strong>{moduleName}</strong>
                  <span>
                    Owner:{' '}
                    {Object.entries(roleMap.owner ?? {})
                      .filter(([, allowed]) => Boolean(allowed))
                      .map(([permission]) => permission)
                      .join(', ') || 'none'}
                  </span>
                </div>
                <span>
                  Contributor:{' '}
                  {Object.entries(roleMap.contributor ?? {})
                    .filter(([, allowed]) => Boolean(allowed))
                    .map(([permission]) => permission)
                    .join(', ') || 'none'}
                </span>
              </div>
            ),
          )}
        </div>
      </SectionPanel>
    </div>
  )
}
