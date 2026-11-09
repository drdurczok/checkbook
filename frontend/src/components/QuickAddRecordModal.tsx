import { useEffect, useId, useMemo, useRef, useState } from "react";
import { OutlinedInput, OutlinedNativeSelect, OutlinedTextarea } from "./ui/OutlinedField";
import {
  Calendar,
  ChevronDown,
  Coins,
  Folder,
  Home,
  Landmark,
  Percent,
  Pencil,
  Plus,
  ReceiptText,
  Repeat,
  StickyNote,
  Tags,
  User,
  Users,
} from "lucide-react";
import { api } from "../lib/api";
import {
  formatAmountDraft,
  parseAmountDraft,
  currencySymbol,
  todayInputValue,
} from "../lib/format";
import { useSession } from "../lib/session";
import { FormSheet } from "./ui/FormSheet";
import { ExpenseNameInput } from "../features/expenses/ExpenseNameInput";
import { useExpenseNameSuggestions } from "../features/expenses/useExpenseNameSuggestions";
import { useQueryClient } from "@tanstack/react-query";
import { expenseCadences } from "../features/expenses/recurring";
import type { ExpenseCadence } from "../contracts/expenses";
import type { ExpenseNameSuggestion } from "../contracts/expenses";
import type {
  AssetSummary,
  Category,
  ExpenseCategorySummary,
  ExpenseGroup,
} from "../types";

type AddRecordKind = "expense" | "recurring" | "loan";

const ADD_RECORD_TABS = [
  { key: "expense", label: "Expense", icon: ReceiptText },
  { key: "recurring", label: "Recurring expense", icon: Repeat },
  { key: "loan", label: "Loan", icon: Landmark },
] as const;

/* The quick-add record dialog shared by the overview and expenses pages: the
   title dropdown picks the record kind (expense entry or loan), and every
   field uses the shared outlined primitive. Rendered through the shared
   FormSheet (add-window chrome) with the kind dropdown passed as the title
   node, anchored by its relative wrapper. Expenses can append a Category
   option that hands off to the page-owned category form.

   The expense form cascades Category → Group when the page passes
   the expenses board (`expenseGroups` + `expenseRows`): Category filters the
   Group list, and a Group is always selected — defaulting to the first
   uncategorized group, or the first group of whichever category is picked. */
export function QuickAddRecordModal({
  categories,
  expenseGroups,
  expenseRows: suppliedExpenseRows,
  properties,
  onClose,
  onAdded,
  onAddCategory,
}: {
  categories: Category[];
  expenseGroups?: ExpenseGroup[];
  expenseRows?: ExpenseCategorySummary[];
  properties: AssetSummary[];
  onClose: () => void;
  onAdded: () => Promise<void> | void;
  onAddCategory?: () => void;
}) {
  // Source projections have no writable ledger category, including on Overview.
  const expenseRows = useMemo(() => suppliedExpenseRows?.filter((row) => !row.utility_property_id), [suppliedExpenseRows]);
  const fieldId = useId();
  const queryClient = useQueryClient();
  const [recurringEnd, setRecurringEnd] = useState("");
  const [cadence, setCadence] = useState<ExpenseCadence>("monthly");
  const { token, currency, setError, setMessage } = useSession();
  const [busy, setBusy] = useState<string | null>(null);
  const [quickAddKind, setQuickAddKind] = useState<AddRecordKind>("expense");
  const [isKindMenuOpen, setIsKindMenuOpen] = useState(false);
  const kindMenuRef = useRef<HTMLDivElement | null>(null);
  const [quickExpense, setQuickExpense] = useState({
    description: "",
    amount: "",
    entry_date: todayInputValue(),
    owner_scope: "joint",
    category_name: "",
    notes: "",
  });
  const [isQuickExpenseNotesOpen, setIsQuickExpenseNotesOpen] = useState(false);
  const [classificationIsManual, setClassificationIsManual] = useState(false);
  const [chosenNameMatch, setChosenNameMatch] = useState<ExpenseNameSuggestion | null>(null);
  const nameHistory = useExpenseNameSuggestions(token ?? "", quickExpense.description, quickAddKind !== "loan");
  const matchedExpense = chosenNameMatch ?? nameHistory.suggestions[0];
  const matchingRow = matchedExpense && (expenseRows
    ? expenseRows.find((row) => row.id === matchedExpense.category_id && row.name === matchedExpense.category_name
        && (row.expense_group_id ?? null) === matchedExpense.expense_group_id && !row.parent_id && !row.is_retired
        && (!row.expense_group_id || expenseGroups?.some((group) => group.id === row.expense_group_id && !group.is_retired)))
    : categories.find((category) => category.id === matchedExpense.category_id && category.kind === "expense" && !category.parent_id));
  const automaticMatch = !classificationIsManual && matchingRow ? matchedExpense : null;
  /* Category filter for the expense cascade: an expense group id, or "" for
   * Uncategorized. */
  const [expenseCategoryFilter, setExpenseCategoryFilter] = useState<string | null>(null);
  const [quickLoan, setQuickLoan] = useState({
    name: "",
    current_balance: "",
    monthly_payment: "",
    original_balance: "",
    interest_rate: "",
    liability_type: "loan",
    owner_scope: "joint",
    start_date: "",
    end_date: "",
    notes: "",
    linked_property_id: "",
  });
  const [isQuickLoanNotesOpen, setIsQuickLoanNotesOpen] = useState(false);

  useEffect(() => {
    if (!isKindMenuOpen) {
      return;
    }
    const close = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        kindMenuRef.current?.contains(event.target)
      ) {
        return;
      }
      setIsKindMenuOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [isKindMenuOpen]);

  async function submitQuickAdd() {
    if (!token) {
      return;
    }
    if (quickAddKind !== "loan" && (!(Number(quickExpense.amount) > 0) || !Number.isFinite(Number(quickExpense.amount)))) {
      setError("Enter an amount greater than zero.");
      return;
    }
    if (quickAddKind !== "loan" && !selectedGroupName) {
      setError("Add a group to this category before adding an expense.");
      return;
    }
    if (quickAddKind === "recurring" && recurringEnd && recurringEnd < quickExpense.entry_date) {
      setError("End date must be on or after the start date.");
      return;
    }
    setBusy(`quick-add-${quickAddKind}`);
    setError(null);
    try {
      if (quickAddKind === "recurring") {
        await api.createRecurringExpense(token, {
          description: quickExpense.description,
          amount: Number(quickExpense.amount),
          start_date: quickExpense.entry_date,
          end_date: recurringEnd || null,
          cadence,
          owner_scope: quickExpense.owner_scope === "self" ? "self" : "joint",
          category_name: selectedGroupName,
          notes: quickExpense.notes,
        });
        await queryClient.invalidateQueries({ predicate: (query) => ["recurring-expenses", "expenses", "overview", "planning-board", "expense-name-suggestions"].includes(String(query.queryKey[0])) });
      }
      if (quickAddKind === "expense") {
        await api.createExpense(token, {
          ...quickExpense,
          category_name: selectedGroupName,
          amount: Number(quickExpense.amount),
        });
        setQuickExpense({
          ...quickExpense,
          description: "",
          amount: "",
          notes: "",
        });
        setIsQuickExpenseNotesOpen(false);
        setClassificationIsManual(false);
        setChosenNameMatch(null);
      }
      if (quickAddKind === "loan") {
        await api.createLoan(token, {
          ...quickLoan,
          current_balance: Number(quickLoan.current_balance || 0),
          monthly_payment: Number(quickLoan.monthly_payment || 0),
          original_balance: quickLoan.original_balance
            ? Number(quickLoan.original_balance)
            : null,
          interest_rate: quickLoan.interest_rate
            ? Number(quickLoan.interest_rate)
            : 0,
          start_date: quickLoan.start_date || null,
          end_date: quickLoan.end_date || null,
          linked_property_id: quickLoan.linked_property_id || null,
        });
        setQuickLoan({
          ...quickLoan,
          name: "",
          current_balance: "",
          monthly_payment: "",
          original_balance: "",
          interest_rate: "",
          start_date: "",
          end_date: "",
          notes: "",
          linked_property_id: "",
        });
        setIsQuickLoanNotesOpen(false);
      }
      await onAdded();
      onClose();
      setMessage(
        `${ADD_RECORD_TABS.find((item) => item.key === quickAddKind)?.label ?? "Record"} added.`,
      );
    } catch (nextError) {
      setError(
        nextError instanceof Error
          ? nextError.message
          : "Record could not be added.",
      );
    } finally {
      setBusy(null);
    }
  }

  const expenseCategoryOptions = categories
    .filter((category) => category.kind === "expense" && !category.parent_id)
    .toSorted((left, right) => left.name.localeCompare(right.name));
  const rootExpenseRows = expenseRows?.filter((row) => !row.parent_id) ?? [];
  const defaultCategory = rootExpenseRows.some((row) => !row.expense_group_id)
    ? ""
    : (rootExpenseRows.toSorted((a, b) => a.sort_order - b.sort_order)[0]
        ?.expense_group_id ?? "");
  const selectedCategory = automaticMatch
    ? automaticMatch.expense_group_id ?? ""
    : expenseCategoryFilter ?? defaultCategory;
  /* Cascade mode (board data provided): root rows of the selected category.
   * Rows keep their category via expense_group_id; null means
   * Uncategorized. */
  const cascadeGroupOptions = useMemo(
    () =>
      expenseRows
        ? expenseRows
            .filter(
              (row) =>
                !row.parent_id &&
                (row.expense_group_id ?? "") === selectedCategory,
            )
            .toSorted((left, right) => left.sort_order - right.sort_order)
        : null,
    [expenseRows, selectedCategory],
  );
  const groupOptions = cascadeGroupOptions ?? expenseCategoryOptions;
  const preferredGroupName = automaticMatch?.category_name ?? quickExpense.category_name;
  const selectedGroupName = groupOptions.some(
    (row) => row.name === preferredGroupName,
  )
    ? preferredGroupName
    : (groupOptions[0]?.name ?? "");
  const activeAddTab =
    ADD_RECORD_TABS.find((item) => item.key === quickAddKind) ??
    ADD_RECORD_TABS[0];
  const ActiveAddIcon = activeAddTab.icon;
  const amountCurrencyHint = currencySymbol(currency);

  return (
    <FormSheet
      className="quick-add-modal record-add-modal"
      leading={
        <div className="record-add-icon" aria-hidden="true">
          <ActiveAddIcon className="h-5 w-5" />
        </div>
      }
      eyebrow="Add record"
      title={
        <span className="record-add-kind" ref={kindMenuRef}>
          <button
            aria-expanded={isKindMenuOpen}
            aria-haspopup="listbox"
            className="record-add-kind-toggle"
            onClick={() => setIsKindMenuOpen((value) => !value)}
            type="button"
          >
            {activeAddTab.label}
            <ChevronDown aria-hidden="true" className="h-4 w-4" />
          </button>
          {isKindMenuOpen ? (
            <div
              aria-label="Record type"
              className="record-add-kind-menu"
              onKeyDown={(event) => {
                // Dismiss the menu first; Escape must not also close
                // the dialog behind it.
                if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  setIsKindMenuOpen(false);
                }
              }}
              role="listbox"
            >
              {ADD_RECORD_TABS.map((item) => (
                <button
                  aria-selected={quickAddKind === item.key}
                  className={quickAddKind === item.key ? "is-active" : ""}
                  key={item.key}
                  onClick={() => {
                    setQuickAddKind(item.key);
                    setIsKindMenuOpen(false);
                  }}
                  role="option"
                  type="button"
                >
                  <item.icon aria-hidden="true" className="h-4 w-4" />
                  {item.label}
                </button>
              ))}
              {onAddCategory ? (
                <button
                  aria-selected={false}
                  onClick={() => {
                    setIsKindMenuOpen(false);
                    onAddCategory();
                  }}
                  role="option"
                  type="button"
                >
                  <Tags aria-hidden="true" className="h-4 w-4" />
                  Category
                </button>
              ) : null}
            </div>
          ) : null}
        </span>
      }
      titleId="quick-add-title"
      onClose={onClose}
    >

        <form
          className="quick-add-form"
          onSubmit={(event) => {
            event.preventDefault();
            void submitQuickAdd();
          }}
        >
          {quickAddKind !== "loan" ? (
            <div className="form-grid">
              <ExpenseNameInput
                id={`${fieldId}-quickExpense-description`}
                value={quickExpense.description}
                suggestions={nameHistory.suggestions}
                searching={nameHistory.searching}
                failed={nameHistory.failed}
                categoryLabel={(suggestion) => {
                  const category = expenseGroups?.find((group) => group.id === suggestion.expense_group_id)?.name;
                  const categoryName = category ?? (suggestion.expense_group_id ? null : "Uncategorized");
                  return categoryName ? `${categoryName} / ${suggestion.category_name}` : suggestion.category_name;
                }}
                onChange={(description) => {
                  setExpenseCategoryFilter(selectedCategory);
                  setQuickExpense((previous) => ({ ...previous, description, category_name: selectedGroupName }));
                  setChosenNameMatch(null);
                }}
                onSelect={(suggestion) => {
                  setExpenseCategoryFilter(selectedCategory);
                  setQuickExpense((previous) => ({ ...previous, description: suggestion.description, category_name: selectedGroupName }));
                  setChosenNameMatch(suggestion);
                }}
              />
              <OutlinedInput
                id={`${fieldId}-quickExpense-amount`}
                label="Amount"
                leadingIcon={<Coins />}
                trailing={<span
                  aria-hidden="true"
                  className={`record-add-field-currency${quickExpense.amount ? "" : " is-empty"}`}
                >
                  {amountCurrencyHint}
                </span>}
                required
                autoComplete="off"
                inputMode="decimal"
                placeholder="Amount"
                value={formatAmountDraft(quickExpense.amount)}
                onChange={(event) =>
                  setQuickExpense({
                    ...quickExpense,
                    amount: parseAmountDraft(event.target.value),
                  })
                }
              />
              <div className={quickAddKind === "recurring" ? "record-add-pair" : undefined}>
              <OutlinedInput
                id={`${fieldId}-quickExpense-entry_date`}
                label={quickAddKind === "recurring" ? "Start" : "Date"}
                leadingIcon={<Calendar />}
                required
                type="date"
                value={quickExpense.entry_date}
                onChange={(event) =>
                  setQuickExpense({
                    ...quickExpense,
                    entry_date: event.target.value,
                  })
                }
              />
              {quickAddKind === "recurring" ? (
                <OutlinedInput id={`${fieldId}-recurring-end`} label="End (optional)" leadingIcon={<Calendar />} type="date" min={quickExpense.entry_date} value={recurringEnd} onChange={(event) => setRecurringEnd(event.target.value)} />
              ) : null}
              </div>
              {quickAddKind === "recurring" ? (
                <OutlinedNativeSelect id={`${fieldId}-recurring-cadence`} label="Frequency (optional)" leadingIcon={<Repeat />} value={cadence} onChange={(event) => { const next = expenseCadences.find((item) => item.value === event.target.value); if (next) setCadence(next.value); }}>
                  {expenseCadences.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                </OutlinedNativeSelect>
              ) : null}
              <div className="record-add-pair">
                {expenseRows ? (
                  <OutlinedNativeSelect
                    id={`${fieldId}-quickExpense-category`}
                    label="Category"
                    leadingIcon={<Tags aria-hidden="true" className="h-4 w-4" />}
                    value={selectedCategory}
                    onChange={(event) => {
                      const filter = event.target.value;
                      setClassificationIsManual(true);
                      setExpenseCategoryFilter(filter);
                      const firstGroup = expenseRows
                        .filter(
                          (row) =>
                            !row.parent_id &&
                            (row.expense_group_id ?? "") === filter,
                        )
                        .toSorted(
                          (left, right) => left.sort_order - right.sort_order,
                        )[0];
                      setQuickExpense((previous) => ({
                        ...previous,
                        category_name: firstGroup?.name ?? "",
                      }));
                    }}
                  >
                    <option value="">Uncategorized</option>
                    {(expenseGroups ?? [])
                      .toSorted((left, right) => left.sort_order - right.sort_order)
                      .map((group) => (
                        <option
                          key={group.id}
                          value={group.id}
                          disabled={!rootExpenseRows?.some((row) => row.expense_group_id === group.id)}
                        >
                          {group.name}
                        </option>
                      ))}
                  </OutlinedNativeSelect>
                ) : null}
                <OutlinedNativeSelect
                  id={`${fieldId}-quickExpense-category_name`}
                  label="Group"
                  leadingIcon={<Folder />}
                  value={selectedGroupName}
                  disabled={!groupOptions.length}
                  onChange={(event) => {
                    setClassificationIsManual(true);
                    setExpenseCategoryFilter(selectedCategory);
                    setQuickExpense({
                      ...quickExpense,
                      category_name: event.target.value,
                    });
                  }}
                >
                  {!groupOptions.length ? <option value="">No groups available</option> : null}
                  {groupOptions.map((category) => (
                    <option key={category.id} value={category.name}>
                      {category.name}
                    </option>
                  ))}
                </OutlinedNativeSelect>
              </div>
              {/* Notes are additive only: "+ Notes" reveals the field and
                  disappears; empty notes simply save as no notes. */}
              {!isQuickExpenseNotesOpen ? (
                <div className="record-add-notes-toggle-row">
                  <button
                    aria-controls={`${fieldId}-quickExpense-notes`}
                    aria-expanded={false}
                    className="record-add-notes-toggle"
                    onClick={() => setIsQuickExpenseNotesOpen(true)}
                    type="button"
                  >
                    <Plus aria-hidden="true" className="h-4 w-4" />
                    Add Notes
                  </button>
                </div>
              ) : null}
              {isQuickExpenseNotesOpen ? (
                <OutlinedTextarea
                  id={`${fieldId}-quickExpense-notes`}
                  label="Notes"
                  className="quick-add-notes"
                  leadingIcon={<StickyNote />}
                  placeholder="Notes"
                  value={quickExpense.notes}
                  onChange={(event) =>
                    setQuickExpense({
                      ...quickExpense,
                      notes: event.target.value,
                    })
                  }
                />
              ) : null}
            </div>
          ) : null}

          {quickAddKind === "loan" ? (
            <div className="form-grid">
              <OutlinedInput
                id={`${fieldId}-quickLoan-name`}
                label="Name"
                leadingIcon={<Pencil />}
                required
                autoComplete="off"
                placeholder="Name"
                value={quickLoan.name}
                onChange={(event) =>
                  setQuickLoan({ ...quickLoan, name: event.target.value })
                }
              />
              <OutlinedInput
                id={`${fieldId}-quickLoan-current_balance`}
                label="Current balance"
                leadingIcon={<Coins />}
                trailing={<span
                  aria-hidden="true"
                  className={`record-add-field-currency${quickLoan.current_balance ? "" : " is-empty"}`}
                >
                  {amountCurrencyHint}
                </span>}
                required
                autoComplete="off"
                inputMode="decimal"
                placeholder="Current balance"
                value={formatAmountDraft(quickLoan.current_balance)}
                onChange={(event) =>
                  setQuickLoan({
                    ...quickLoan,
                    current_balance: parseAmountDraft(
                      event.target.value,
                    ),
                  })
                }
              />
              <OutlinedInput
                id={`${fieldId}-quickLoan-original_balance`}
                label="Loan amount"
                leadingIcon={<Coins />}
                trailing={<span
                  aria-hidden="true"
                  className={`record-add-field-currency${quickLoan.original_balance ? "" : " is-empty"}`}
                >
                  {amountCurrencyHint}
                </span>}
                autoComplete="off"
                inputMode="decimal"
                placeholder="Loan amount"
                value={formatAmountDraft(quickLoan.original_balance)}
                onChange={(event) =>
                  setQuickLoan({
                    ...quickLoan,
                    original_balance: parseAmountDraft(
                      event.target.value,
                    ),
                  })
                }
              />
              <OutlinedInput
                id={`${fieldId}-quickLoan-monthly_payment`}
                label="Monthly payment"
                leadingIcon={<Coins />}
                trailing={<span
                  aria-hidden="true"
                  className={`record-add-field-currency${quickLoan.monthly_payment ? "" : " is-empty"}`}
                >
                  {amountCurrencyHint}
                </span>}
                required
                autoComplete="off"
                inputMode="decimal"
                placeholder="Monthly payment"
                value={formatAmountDraft(quickLoan.monthly_payment)}
                onChange={(event) =>
                  setQuickLoan({
                    ...quickLoan,
                    monthly_payment: parseAmountDraft(
                      event.target.value,
                    ),
                  })
                }
              />
              <OutlinedInput
                id={`${fieldId}-quickLoan-interest_rate`}
                label="Interest rate"
                leadingIcon={<Percent />}
                trailing={<span
                  aria-hidden="true"
                  className={`record-add-field-currency${quickLoan.interest_rate ? "" : " is-empty"}`}
                >
                  %
                </span>}
                autoComplete="off"
                inputMode="decimal"
                placeholder="Interest rate"
                value={formatAmountDraft(quickLoan.interest_rate)}
                onChange={(event) =>
                  setQuickLoan({
                    ...quickLoan,
                    interest_rate: parseAmountDraft(
                      event.target.value,
                    ),
                  })
                }
              />
              <OutlinedNativeSelect
                id={`${fieldId}-quickLoan-liability_type`}
                label="Type"
                leadingIcon={<Landmark />}
                value={quickLoan.liability_type}
                onChange={(event) =>
                  setQuickLoan({
                    ...quickLoan,
                    liability_type: event.target.value,
                  })
                }
              >
                <option value="loan">Loan</option>
                <option value="mortgage">Mortgage</option>
                <option value="debt">Debt</option>
              </OutlinedNativeSelect>
              <OutlinedNativeSelect
                id={`${fieldId}-quickLoan-linked_property_id`}
                label="Linked property or vehicle"
                leadingIcon={<Home />}
                value={quickLoan.linked_property_id}
                onChange={(event) =>
                  setQuickLoan({
                    ...quickLoan,
                    linked_property_id: event.target.value,
                  })
                }
              >
                <option value="">None</option>
                {properties.map((property) => (
                  <option key={property.id} value={property.id}>
                    {property.name}
                  </option>
                ))}
              </OutlinedNativeSelect>
              <div className="field-pair">
                <OutlinedInput
                  id={`${fieldId}-quickLoan-start_date`}
                  label="Start"
                  leadingIcon={<Calendar />}
                  type="date"
                  value={quickLoan.start_date}
                  onChange={(event) =>
                    setQuickLoan({
                      ...quickLoan,
                      start_date: event.target.value,
                    })
                  }
                />
                <OutlinedInput
                  id={`${fieldId}-quickLoan-end_date`}
                  label="End"
                  leadingIcon={<Calendar />}
                  type="date"
                  value={quickLoan.end_date}
                  onChange={(event) =>
                    setQuickLoan({
                      ...quickLoan,
                      end_date: event.target.value,
                    })
                  }
                />
              </div>
              {!isQuickLoanNotesOpen ? (
                <div className="record-add-notes-toggle-row">
                  <button
                    aria-controls={`${fieldId}-quickLoan-notes`}
                    aria-expanded={false}
                    className="record-add-notes-toggle"
                    onClick={() => setIsQuickLoanNotesOpen(true)}
                    type="button"
                  >
                    <Plus aria-hidden="true" className="h-4 w-4" />
                    Add Notes
                  </button>
                </div>
              ) : null}
              {isQuickLoanNotesOpen ? (
                <OutlinedTextarea
                  id={`${fieldId}-quickLoan-notes`}
                  label="Notes"
                  className="quick-add-notes"
                  leadingIcon={<StickyNote />}
                  placeholder="Notes"
                  value={quickLoan.notes}
                  onChange={(event) =>
                    setQuickLoan({
                      ...quickLoan,
                      notes: event.target.value,
                    })
                  }
                />
              ) : null}
            </div>
          ) : null}

          <div className="quick-add-actions">
            <button
              className="button"
              disabled={busy === `quick-add-${quickAddKind}`}
              type="submit"
            >
              {busy === `quick-add-${quickAddKind}`
                ? "Adding..."
                : `Add ${activeAddTab.label}`}
            </button>
            {quickAddKind !== "loan" ? (
              <button
                aria-pressed={quickExpense.owner_scope === "self"}
                aria-label={`Owner: ${quickExpense.owner_scope === "self" ? "Self" : "Joint"}. Tap to switch`}
                className="quick-add-owner-toggle"
                onClick={() =>
                  setQuickExpense({
                    ...quickExpense,
                    owner_scope:
                      quickExpense.owner_scope === "self" ? "joint" : "self",
                  })
                }
                title={`Owner: ${quickExpense.owner_scope === "self" ? "Self" : "Joint"} (tap to switch)`}
                type="button"
              >
                {quickExpense.owner_scope === "self" ? (
                  <User aria-hidden="true" className="h-5 w-5" />
                ) : (
                  <Users aria-hidden="true" className="h-5 w-5" />
                )}
              </button>
            ) : null}
          </div>
        </form>
    </FormSheet>
  );
}
