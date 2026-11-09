import type { ComponentProps } from 'react'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ProjectModal } from './ProjectModal'
import type { AssetSummary } from '../types'

const baseProject: AssetSummary = {
  id: 'project-1',
  name: 'Kitchen remodel',
  total_cost: 0,
  valuation_date: '2026-01-31',
  status: 'active',
  started_on: '2026-01-01',
  ended_on: '2026-03-31',
  notes: '',
  kind: 'project',
  details: {
    rooms: [
      {
        name: 'Kitchen',
        sections: [
          {
            name: 'Cabinets',
            items: [
              { name: 'Shelving', quantity: 4, unit_price: 2500, total_cost: 0, notes: '', completed: false },
            ],
          },
        ],
      },
    ],
  },
}

function renderProject(project: AssetSummary, props: Partial<ComponentProps<typeof ProjectModal>> = {}) {
  return render(
    <ProjectModal
      assets={[]}
      categoryOptions={['Home']}
      currency="PLN"
      initialMode="edit"
      project={project}
      saving={false}
      onClose={() => {}}
      onSave={vi.fn(async () => true)}
      onAutoSave={vi.fn()}
      onLinkAsset={() => {}}
      {...props}
    />,
  )
}

describe('ProjectModal outlined fields', () => {
  it('puts Edit in the overflow menu and Escape dismisses only the menu', async () => {
    const onClose = vi.fn()
    renderProject(baseProject, { initialMode: 'view', onClose })
    expect(screen.queryByRole('button', { name: 'Edit project' })).toBeNull()
    const trigger = screen.getByRole('button', { name: 'Project actions' })
    await userEvent.click(trigger)
    expect(screen.getByRole('menuitem', { name: 'Edit' })).toHaveFocus()
    await userEvent.keyboard('{Escape}')
    expect(onClose).not.toHaveBeenCalled()
    expect(trigger).toHaveFocus()
    await userEvent.click(trigger)
    await userEvent.click(screen.getByRole('menuitem', { name: 'Edit' }))
    expect(screen.getByRole('textbox', { name: 'Project name' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Close project details' })).toHaveClass('record-add-close')
  })

  it('keeps sibling groups inside their top-level category and autosaves the correct item', async () => {
    const onAutoSave = vi.fn()
    const project: AssetSummary = {
      ...baseProject,
      details: {
        rooms: [
          { name: 'Kitchen', sections: [
            { name: 'Cabinets', items: [{ name: 'Shelving', quantity: 4, unit_price: 2500, completed: false }] },
            { name: 'Lighting', items: [{ name: 'Pendant', quantity: 0, unit_price: 250, completed: false }] },
          ] },
          { name: 'Bathroom', sections: [
            { name: 'Fixtures', items: [{ name: 'Sink', total_cost: 300, completed: false }] },
          ] },
        ],
      },
    }
    renderProject(project, { initialMode: 'view', onAutoSave })
    // The modal is portaled to document.body, not the render container.
    expect(document.body.querySelectorAll('.project-room')).toHaveLength(2)
    const kitchen = screen.getByRole('region', { name: 'Kitchen' })
    expect(within(kitchen).getAllByRole('button')).toHaveLength(2)
    expect(within(kitchen).queryByRole('button', { name: /Fixtures/ })).toBeNull()
    await userEvent.click(within(kitchen).getByRole('button', { name: /Lighting/ }))
    const pricing = kitchen.querySelector('.project-item__pricing')
    expect(pricing?.querySelector('.project-item__calculation')).toHaveTextContent('0 \u00d7 250')
    expect(pricing?.querySelector('.project-item__total')).toHaveTextContent('PLN 0')
    await userEvent.click(within(kitchen).getByRole('checkbox', { name: 'Mark as done' }))
    expect(onAutoSave).toHaveBeenCalledWith(expect.objectContaining({ details: expect.objectContaining({
      rooms: [
        expect.objectContaining({ sections: [
          expect.objectContaining({ items: [expect.objectContaining({ completed: false })] }),
          expect.objectContaining({ items: [expect.objectContaining({ completed: true })] }),
        ] }),
        expect.objectContaining({ sections: [expect.objectContaining({ items: [expect.objectContaining({ completed: false })] })] }),
      ],
    }) }))
  })

  it('omits the property pill in view mode but keeps linking available when editing', async () => {
    const onLinkAsset = vi.fn()
    renderProject({ ...baseProject, linked_asset_id: 'property-1' }, {
      initialMode: 'view',
      assets: [{ ...baseProject, id: 'property-1', kind: 'asset', name: 'Home' }],
      onLinkAsset,
    })
    expect(document.body.querySelector('.project-hero-link-slot')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Unlink Home' })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Project actions' }))
    await userEvent.click(screen.getByRole('menuitem', { name: 'Edit' }))
    await userEvent.click(screen.getByRole('button', { name: 'Unlink Home' }))
    expect(onLinkAsset).toHaveBeenCalledWith(null, null)
  })

  it('labels the outlined meta fields and keeps icons and date controls', () => {
    renderProject(baseProject)
    // The modal is portaled to document.body, not the render container.
    const dialog = document.body

    const category = screen.getByRole('combobox', { name: 'Category' })
    expect(category).toHaveAttribute('placeholder', 'Start typing...')
    expect(document.getElementById(category.getAttribute('list') ?? '')?.querySelector('option')).toHaveAttribute('value', 'Home')
    expect(screen.getByLabelText('From')).toHaveAttribute('type', 'date')
    expect(screen.getByLabelText('To')).toHaveAttribute('type', 'date')
    expect(screen.getByRole('combobox', { name: 'Color' })).toBeInTheDocument()
    expect(dialog.querySelectorAll('.project-meta-grid .outlined-field__icon')).toHaveLength(4)
    expect(dialog.querySelectorAll('.project-meta-grid .is-date .outlined-field__label')).toHaveLength(2)
    expect(dialog.querySelector('.record-add-field-control, label.inline-field')).toBeNull()
  })

  it('reveals project notes via the additive toggle', async () => {
    renderProject(baseProject)

    const toggle = screen.getByRole('button', { name: 'Notes' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByLabelText('Notes')).toBeNull()

    await userEvent.click(toggle)
    // The toggle is additive: it disappears once the field is revealed.
    expect(screen.queryByRole('button', { name: 'Notes' })).toBeNull()
    expect(screen.getByLabelText('Notes')).toHaveAttribute(
      'placeholder',
      'Optional details, links, reminders...',
    )
  })

  it('shows the notes field directly, with no toggle, when the project already has notes', () => {
    renderProject({ ...baseProject, notes: 'Check contractor quotes' })

    expect(screen.queryByRole('button', { name: 'Notes' })).toBeNull()
    expect(screen.getByLabelText('Notes')).toHaveValue('Check contractor quotes')
  })

  it('keeps native property and section selection events', async () => {
    const onLinkAsset = vi.fn()
    renderProject(baseProject, {
      assets: [{ ...baseProject, id: 'property-1', kind: 'asset', name: 'Home' }],
      onLinkAsset,
    })

    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Link a property' }), 'property-1')
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Choose a section' }), '0')
    expect(onLinkAsset).toHaveBeenCalledWith('property-1', '0')
  })

  it('discards canceled edits and never autosaves them', async () => {
    const onAutoSave = vi.fn()
    renderProject(baseProject, { onAutoSave })

    const nameField = screen.getByRole('textbox', { name: 'Project name' })
    await userEvent.clear(nameField)
    await userEvent.type(nameField, 'Canceled rename')
    await userEvent.click(screen.getByRole('button', { name: 'Cancel editing project' }))

    // View mode shows the persisted name, not the canceled draft.
    expect(screen.getByRole('heading', { name: 'Kitchen remodel' })).toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: 'Project name' })).toBeNull()

    // A view-mode completion toggle autosaves only persisted data.
    await userEvent.click(screen.getByRole('button', { name: /Cabinets/ }))
    await userEvent.click(screen.getByRole('checkbox', { name: 'Mark as done' }))
    expect(onAutoSave).toHaveBeenCalledTimes(1)
    expect(onAutoSave.mock.calls[0][0]).toMatchObject({ name: 'Kitchen remodel' })
  })

  it('gives repeated item editors unique outlined control IDs and preserves calculated totals', async () => {
    renderProject(baseProject)
    // The modal is portaled to document.body, not the render container.
    const dialog = document.body
    await userEvent.click(screen.getByRole('button', { name: 'Expand group' }))
    await userEvent.click(screen.getByRole('button', { name: 'Item details' }))
    await userEvent.click(screen.getByRole('button', { name: 'Item' }))
    await userEvent.click(screen.getAllByRole('button', { name: 'Item details' })[1])

    const controls = [...dialog.querySelectorAll<HTMLInputElement>('.outlined-field__input')]
    expect(new Set(controls.map((control) => control.id)).size).toBe(controls.length)
    expect(controls.every((control) => control.id && control.labels?.length === 1)).toBe(true)
    expect(screen.getAllByRole('spinbutton', { name: 'Item total' })).toHaveLength(1)
    expect(screen.getAllByRole('checkbox')).toHaveLength(2)
    await userEvent.clear(screen.getAllByRole('textbox', { name: 'Quantity' })[0])
    expect(screen.getAllByRole('spinbutton', { name: 'Item total' })).toHaveLength(2)
  })

  it('formats the unit price with grouping and a currency in item details', async () => {
    renderProject(baseProject)
    // The modal is portaled to document.body, not the render container.
    const dialog = document.body

    await userEvent.click(screen.getByRole('button', { name: 'Expand group' }))
    await userEvent.click(screen.getByRole('button', { name: 'Item details' }))

    const unitPrice = screen.getByRole('textbox', { name: 'Unit price' })
    expect(unitPrice).toHaveAttribute('inputmode', 'decimal')
    expect(unitPrice).toHaveValue('2\u2009500')

    const badge = dialog.querySelector('.project-item__details .record-add-field-currency')
    expect(badge).not.toHaveClass('is-empty')
    expect(badge?.textContent).not.toBe('')

    expect(screen.getByRole('textbox', { name: 'Quantity' })).toHaveValue('4')
    expect(dialog.querySelectorAll('.project-item__details .outlined-field__icon')).toHaveLength(3)
  })
})
