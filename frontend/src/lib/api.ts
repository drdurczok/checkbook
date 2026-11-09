import { assetsApi } from '../api/assets'
import { authApi } from '../api/auth'
import { backupsApi } from '../api/backups'
import { dashboardApi } from '../api/dashboard'
import { expensesApi } from '../api/expenses'
import { householdApi } from '../api/household'
import { importsApi } from '../api/imports'
import { incomeApi } from '../api/income'
import { invoicesApi } from '../api/invoices'
import { paydayPlannerApi } from '../api/payday-planner'
import { utilitiesApi } from '../api/utilities'

export const api = {
  ...assetsApi,
  ...authApi,
  ...backupsApi,
  ...dashboardApi,
  ...expensesApi,
  ...householdApi,
  ...importsApi,
  ...incomeApi,
  ...invoicesApi,
  ...paydayPlannerApi,
  ...utilitiesApi,
}
