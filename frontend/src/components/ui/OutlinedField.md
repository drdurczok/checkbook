# Outlined Fields

Shared application replacement for legacy `inline-field` / `record-add-field`
wrappers. All native text, number, date, month, select, and textarea controls use
this family. `Checkbox` and `FileInput` in `NativeControls.tsx` preserve specialized
native semantics without a text-field shell.

```tsx
<OutlinedInput
  id="invoice-amount"
  label="Amount"
  value={amount}
  inputMode="decimal"
  leadingIcon={<Coins />}
  trailing="PLN"
  onChange={(event) => setAmount(event.target.value)}
  hint="Enter the invoice total."
  error={amountError}
/>
```

- `OutlinedInput` passes native input props through, including `type`, `readOnly`,
  `required`, event handlers, and `ref`. `OutlinedTextarea` does the same for a
  textarea, with natural multiline flow and vertical resizing.
- `OutlinedNativeSelect` preserves native `select` events, option/optgroup children,
  keyboard behavior, and refs while using the same outlined shell. Prefer it when
  retaining existing native selection semantics; use `OutlinedSelect` for rich
  two-line/icon option lists.
- `OutlinedSelect` accepts controlled string values and options with `value`,
  `label`, optional `secondary`, and optional `icon`. An empty string shows the
  field label as a placeholder; include an empty option to allow clearing.
- `OutlinedField` is the layout primitive for other controls. Its render callback
  supplies the control id, disabled state, and description/error ARIA attributes.
  Use `outlined-field__input` on the control. Give each field a unique id.
- Hints, suggestion buttons, and errors belong in `hint` / `error`, never inside
  the shell. They flow below it and do not alter its height. Hints and errors are
  connected to the control with `aria-describedby`.
- Icons and trailing adornments are decorative (hidden from assistive tech).
  Include meaningful units in the label or hint if they must be announced.
- Do not combine these components with legacy field wrapper classes. Page layout
  classes (e.g. spanning a form grid) can be supplied through `className`.

## Layout Contract

`outlined-field.css` owns the visual system. A fixed-height flex shell centers
single-line inputs, icons, currencies, and dropdown text. A separate decorative
fieldset/legend paints only the notched outline; it never contains the control
and cannot affect its dimensions. A real HTML label names the control. Label
and legend share font metrics, with padding around the notch. No label background
or measured text width is needed.

Height and spacing use component custom properties (`--field-height`,
`--field-label-size`, `--field-label-line`, `--field-padding`). Keep the single-line
height large enough for the dropdown's optional two-line source name/job title.
Multiline fields intentionally grow with their textarea rather than clipping it.

The select keeps focus on its combobox trigger and supports arrows, Home/End,
Enter/Space, Escape, Tab, and typeahead. Its listbox flips and constrains itself to
the viewport. The popup is not portaled: do not mount it in a container that clips
its popup; an overlay/portal integration is needed for such consumers.

## Regression Checks

- `OutlinedField.test.tsx`: accessible labels, hint/error placement, disabled and
  multiline controls.
- `OutlinedSelect.test.tsx`: keyboard, pointer, focus, typeahead, and placement.
- `e2e/payday-planner.spec.ts`: allocation field integration and independent
  dialog scrolling at mobile and desktop widths.
