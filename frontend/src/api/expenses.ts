import type { ManualRecordResponse } from '../contracts/assets'
import type { ExpenseCategoryDetail, ExpenseCategoryPayload, ExpenseCategorySummary, ExpenseEntryUpdatePayload, ExpenseGroup, ExpenseGroupPayload, ExpenseNameSuggestion, ExpensesBoard } from '../contracts/expenses'
import { request } from './http'
import type { RecurringExpense, RecurringExpensePayload } from '../contracts/expenses'

export const expensesApi = {
  getRecurringExpenses: (token: string) =>
    request<RecurringExpense[]>('/household/expenses/recurring', { token }),
  createRecurringExpense: (token: string, payload: RecurringExpensePayload) =>
    request<RecurringExpense>('/household/expenses/recurring', { method: 'POST', token, body: payload }),
  updateRecurringExpense: (token: string, id: string, payload: RecurringExpensePayload) =>
    request<RecurringExpense>(`/household/expenses/recurring/${id}`, { method: 'PUT', token, body: payload }),
  expenseRecurringNow: (token: string, id: string) =>
    request<RecurringExpense>(`/household/expenses/recurring/${id}/expense-now`, { method: 'POST', token }),
  retireRecurringExpense: (token: string, id: string) =>
    request<RecurringExpense>(`/household/expenses/recurring/${id}/retire`, { method: 'POST', token }),
  getExpenseNameSuggestions: (token: string, query: string) =>
    request<ExpenseNameSuggestion[]>(`/household/expenses/suggestions?${new URLSearchParams({ query })}`, { token }),
  createExpense: (
    token: string,
    payload: {
      description: string
      amount: number
      entry_date: string
      owner_scope: string
      category_name: string
      subcategory_name?: string
      notes?: string
    },
  ) => request<ManualRecordResponse>('/household/expenses', { method: 'POST', token, body: payload }),
  getExpensesBoard: (token: string, range?: { start_date?: string; end_date?: string }) => {
    const params = new URLSearchParams()
    if (range?.start_date) {
      params.set('start_date', range.start_date)
    }
    if (range?.end_date) {
      params.set('end_date', range.end_date)
    }
    const query = params.toString()
    return request<ExpensesBoard>(`/household/expenses/board${query ? `?${query}` : ''}`, { token })
  },
  updateExpenseEntry: (token: string, entryId: string, payload: ExpenseEntryUpdatePayload) =>
    request<{ ok: boolean }>(`/household/expenses/${entryId}`, { method: 'PUT', token, body: payload }),
  deleteExpenseEntry: (token: string, entryId: string) =>
    request<{ ok: boolean }>(`/household/expenses/${entryId}`, { method: 'DELETE', token }),
  createExpenseGroup: (token: string, payload: ExpenseGroupPayload) =>
    request<ExpenseGroup>('/household/expense-groups', { method: 'POST', token, body: payload }),
  updateExpenseGroup: (token: string, id: string, payload: ExpenseGroupPayload) =>
    request<ExpenseGroup>(`/household/expense-groups/${id}`, { method: 'PUT', token, body: payload }),
  deleteExpenseGroup: (token: string, id: string) =>
    request<{ ok: boolean }>(`/household/expense-groups/${id}`, { method: 'DELETE', token }),
  createExpenseCategory: (token: string, payload: ExpenseCategoryPayload) =>
    request<ExpenseCategorySummary>('/household/expense-categories', { method: 'POST', token, body: payload }),
  getExpenseCategoryDetail: (token: string, id: string) =>
    request<ExpenseCategoryDetail>(`/household/expense-categories/${id}`, { token }),
  updateExpenseCategory: (token: string, id: string, payload: ExpenseCategoryPayload) =>
    request<ExpenseCategorySummary>(`/household/expense-categories/${id}`, { method: 'PUT', token, body: payload }),
  deleteExpenseCategory: (token: string, id: string) =>
    request<{ ok: boolean }>(`/household/expense-categories/${id}`, { method: 'DELETE', token }),
}
