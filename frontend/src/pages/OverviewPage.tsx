import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import {
  CashFlowChart,
  DonutChart,
  LineChart,
  SankeyChart,
  StackedBarChart,
} from "../components/charts";
import { Modal } from "../components/Modal";
import { DetailModal } from "../components/DetailModal";
import { DetailActionsMenu } from "../components/DetailActionsMenu";
import { PropertyDetailModal } from "../components/PropertyDetailModal";
import { FilterToggle } from "../components/FilterToggle";
import {
  groupRowsByYear,
  MonthTableShell,
  monthNumberLabel,
  YearDividerRow,
} from "../components/MonthTable";
import { QuickAddRecordModal } from "../components/QuickAddRecordModal";
import { EmptyState, SectionPanel } from "../components/panel";
import { usePropertyMutations } from "../features/properties/usePropertyMutations";
import { LoanDetailModal } from "../features/loans/LoanDetailModal";
import { api } from "../lib/api";
import { NetWorthMonthEditor } from "../features/net-worth/NetWorthMonthEditor";
import { draftNetWorthMonth, fmtGrowthDelta, growthDeltaTone, nextNetWorthMonth, NET_WORTH_GROUPS } from "../features/net-worth/model";
import type { NetWorthGroupKey } from "../contracts/dashboard";
import { groupedExpenseMix } from "../lib/expenses";
import {
  fmtCurrency,
  fmtNumber,
  resolveDateRange,
} from "../lib/format";
import type { DateRangeKey } from "../lib/format";
import { useSession } from "../lib/session";
import { usePropertyDetailHandlers } from "../lib/usePropertyDetailHandlers";
import { LoanSummaryCard } from "../features/loans/LoanSummaryCard";
import type {
  AssetDetailRoom,
  AssetSummary,
  Category,
  DashboardOverview,
  ExpenseCategorySummary,
  ExpenseGroup,
  LoanSummary,
} from "../types";

const isPaidOffLoan = (loan: LoanSummary) => Math.abs(loan.current_balance) < 1;

const assetRooms = (asset: AssetSummary | null): AssetDetailRoom[] => {
  const rooms = asset?.details?.rooms;
  if (!Array.isArray(rooms)) {
    return [];
  }
  return rooms.filter((room): room is AssetDetailRoom => {
    if (!room || typeof room !== "object") {
      return false;
    }
    const candidate = room as Partial<AssetDetailRoom>;
    return (
      typeof candidate.name === "string" && Array.isArray(candidate.sections)
    );
  });
};

const monthlyExpenseStats = (
  points: DashboardOverview["expense_trend_by_category"],
  category: string | null,
) => {
  const totals = points
    .map((point) =>
      category
        ? Number(point.values[category]) || 0
        : Object.values(point.values).reduce(
            (sum, value) => sum + (Number(value) || 0),
            0,
          ),
    )
    .filter((value) => value > 0);
  if (!totals.length) {
    return { average: 0, averageDeviation: 0, months: 0 };
  }
  const average = totals.reduce((sum, value) => sum + value, 0) / totals.length;
  const averageDeviation =
    totals.reduce((sum, value) => sum + Math.abs(value - average), 0) /
    totals.length;
  return {
    average: Number.isFinite(average) ? average : 0,
    averageDeviation: Number.isFinite(averageDeviation) ? averageDeviation : 0,
    months: totals.length,
  };
};

const sumValues = (items: Array<{ value: number }>) =>
  items.reduce((sum, item) => sum + item.value, 0);

const valueChange = (value: number, previous?: number | null) => {
  if (previous === null || previous === undefined || Math.abs(previous) < 1) {
    return null;
  }
  return (value - previous) / Math.abs(previous);
};

const heatCellProps = (change: number | null | undefined, enabled: boolean) => {
  if (
    !enabled ||
    change === null ||
    change === undefined ||
    Math.abs(change) < 0.0001
  ) {
    return { className: "" };
  }
  const alpha = Math.min(
    0.42,
    Math.max(0.06, (Math.log1p(Math.abs(change) * 12) / Math.log1p(12)) * 0.42),
  );
  return {
    className: `net-worth-change-cell ${change >= 0 ? "is-positive" : "is-negative"}`,
    style: { "--change-alpha": alpha.toFixed(3) } as CSSProperties,
  };
};

const netWorthGroupTotal = (
  row: DashboardOverview["net_worth_components"][number],
  group: { key: NetWorthGroupKey },
) => row[group.key].total * (group.key === "debt" ? -1 : 1);

export function OverviewPage({
  dateRange,
  showForecast = false,
  onNavigateToProjects,
}: {
  dateRange: DateRangeKey;
  showForecast?: boolean;
  onNavigateToProjects?: (propertyId: string) => void;
}) {
  const { token, currency, setError, session } = useSession();
  const [dashboard, setDashboard] = useState<DashboardOverview | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [expenseGroups, setExpenseGroups] = useState<ExpenseGroup[]>([]);
  const [expenseBoardRows, setExpenseBoardRows] = useState<
    ExpenseCategorySummary[]
  >([]);
  const [loans, setLoans] = useState<LoanSummary[]>([]);
  const [showPaidOffLoans, setShowPaidOffLoans] = useState(false);
  const [selectedExpenseCategory, setSelectedExpenseCategory] = useState<
    string | null
  >(null);
  const [showNetWorthForecast, setShowNetWorthForecast] = useState(false);
  const [assets, setAssets] = useState<AssetSummary[]>([]);
  const [selectedLoan, setSelectedLoan] = useState<LoanSummary | null>(null);
  const [selectedAsset, setSelectedAsset] = useState<AssetSummary | null>(null);
  const [isCashFlowModalOpen, setIsCashFlowModalOpen] = useState(false);
  const [isNetWorthModalOpen, setIsNetWorthModalOpen] = useState(false);
  const [isExpenseMixModalOpen, setIsExpenseMixModalOpen] = useState(false);
  const [isSavingsModalOpen, setIsSavingsModalOpen] = useState(false);
  const [isFlowModalOpen, setIsFlowModalOpen] = useState(false);
  const [isQuickAddOpen, setIsQuickAddOpen] = useState(false);
  const [isNetWorthHeatEnabled, setIsNetWorthHeatEnabled] = useState(false);
  const [selectedNetWorthMonth, setSelectedNetWorthMonth] = useState<DashboardOverview["net_worth_components"][number] | null>(null);

  const overviewQuery = useQuery({
    queryKey: ["overview", token, dateRange, showForecast],
    enabled: Boolean(token),
    queryFn: async () => {
      const [overview, categories, loans, assets, expensesBoard] =
        await Promise.all([
          api.getDashboardOverview(token, resolveDateRange(dateRange, showForecast)),
          api.getCategories(token),
          api.getLoans(token),
          api.getAssets(token),
          api.getExpensesBoard(token),
        ]);
      return { overview, categories, loans, assets, expensesBoard };
    },
  });

  /* Local copies of the query payload (kept as state because mutation
     handlers below update parts of it) are adopted during render rather
     than in effects: clearing the stale dashboard when the range prop
     changes and adopting a fresh payload are both "adjust state when a
     prop changes" resets, and render-time adjustment avoids the extra
     paint an effect causes. `appliedQueryData` starts undefined so a
     warm cache on mount still adopts its payload. */
  const rangeKey = `${dateRange}:${showForecast}`;
  const [appliedRange, setAppliedRange] = useState(rangeKey);
  const [appliedQueryData, setAppliedQueryData] = useState<
    typeof overviewQuery.data
  >(undefined);
  if (appliedRange !== rangeKey) {
    setAppliedRange(rangeKey);
    setDashboard(null);
  }
  if (appliedQueryData !== overviewQuery.data) {
    setAppliedQueryData(overviewQuery.data);
    if (overviewQuery.data) {
      setDashboard(overviewQuery.data.overview);
      setCategories(overviewQuery.data.categories);
      setLoans(overviewQuery.data.loans);
      setAssets(overviewQuery.data.assets);
      setExpenseGroups(overviewQuery.data.expensesBoard.groups);
      setExpenseBoardRows(overviewQuery.data.expensesBoard.categories);
    }
  }

  useEffect(() => {
    if (overviewQuery.error) {
      setError(
        overviewQuery.error instanceof Error
          ? overviewQuery.error.message
          : "Failed to refresh workspace.",
      );
    }
  }, [overviewQuery.error, setError]);

  const load = async () => {
    await overviewQuery.refetch();
  };

  const propertyMutations = usePropertyMutations({
    selectedProperty: selectedAsset,
    setSelectedProperty: setSelectedAsset,
    setCategories,
    updateRecord: (updated) =>
      setAssets((current) =>
        current.map((item) => (item.id === updated.id ? updated : item)),
      ),
  });

  const {
    listValuations,
    addValuation,
    removeValuation,
    linkProject,
    unlinkProject,
    listUtilityFields,
    trackUtilityField,
    untrackUtilityField,
  } = usePropertyDetailHandlers({
    token,
    selectedProperty: selectedAsset,
    setError,
    onRecordUpdated: (updated) =>
      setAssets((current) =>
        current.map((item) => (item.id === updated.id ? updated : item)),
      ),
  });

  const properties = assets.filter(
    (asset) => (asset.kind ?? "asset") === "asset",
  );
  const visibleLoans = (
    showPaidOffLoans ? loans : loans.filter((loan) => !isPaidOffLoan(loan))
  ).toSorted((left, right) => {
    const leftPaidOff = isPaidOffLoan(left);
    const rightPaidOff = isPaidOffLoan(right);
    if (leftPaidOff !== rightPaidOff) {
      return leftPaidOff ? 1 : -1;
    }
    return left.name.localeCompare(right.name);
  });
  const paidOffLoanCount =
    loans.length - loans.filter((loan) => !isPaidOffLoan(loan)).length;
  const expenseMix = dashboard
    ? groupedExpenseMix(
        dashboard.expense_breakdown,
        dashboard.expense_trend_by_category,
        expenseGroups,
      )
    : null;
  const expenseCategories = expenseMix?.breakdown ?? [];
  const selectedExpenseBreakdown = selectedExpenseCategory
    ? expenseCategories.filter((item) => item.label === selectedExpenseCategory)
    : expenseCategories;
  const expenseStats = expenseMix
    ? monthlyExpenseStats(expenseMix.trend, selectedExpenseCategory)
    : { average: 0, averageDeviation: 0, months: 0 };
  const netWorthRows = dashboard?.net_worth_components ?? [];
  const previousNetWorthRows = new Map(
    netWorthRows.map((row, index) => [
      row.period,
      netWorthRows[index - 1] ?? null,
    ]),
  );
  const renderNetWorthMonthRow = (row: (typeof netWorthRows)[number]) => {
    const previousRow = previousNetWorthRows.get(row.period) ?? null;
    const totalHeatProps = heatCellProps(
      valueChange(row.total, previousRow?.total),
      isNetWorthHeatEnabled,
    );
    return (
        <tr
          key={row.period}
          className={`net-worth-table__summary-row ${row.completed ? "is-completed" : ""}`}
          aria-label={`Edit net worth ${row.period}${row.completed ? ", completed" : ""}`}
          onClick={() => setSelectedNetWorthMonth(row)}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              setSelectedNetWorthMonth(row);
            }
          }}
          tabIndex={0}
        >
          <th>
            <span className="net-worth-row-label">
              {monthNumberLabel(row.period)}
            </span>
          </th>
          <td className={totalHeatProps.className} style={totalHeatProps.style}>
            <span className="net-worth-table__value">
              <strong>{fmtNumber(row.total)}</strong>
              <span
                className={`net-worth-table__growth ${
                  row.growth === null || row.growth === undefined
                    ? ""
                    : growthDeltaTone(row.growth)
                }`}
              >
                {row.growth === null || row.growth === undefined
                  ? ""
                  : `(${fmtGrowthDelta(row.growth)})`}
              </span>
            </span>
          </td>
          {NET_WORTH_GROUPS.map((netGroup) => {
            const value = netWorthGroupTotal(row, netGroup);
            const previousValue = previousRow
              ? netWorthGroupTotal(previousRow, netGroup)
              : null;
            const heatProps = heatCellProps(
              valueChange(value, previousValue),
              isNetWorthHeatEnabled,
            );
            return (
              <td
                className={heatProps.className}
                key={`${row.period}-${netGroup.key}-total`}
                style={heatProps.style}
              >
                {fmtNumber(value)}
              </td>
            );
          })}
        </tr>

    );
  };


  return (
    <>
      {dashboard ? (
        <div className="page-stack overview-page">
          <div className="grid grid--two">
            <SectionPanel
              title="Net worth"
              actions={
                <div className="net-worth-panel-actions">
                  <FilterToggle label="Forecast" checked={showNetWorthForecast} onChange={setShowNetWorthForecast} compact />
                  <button
                    className="button button--compact button--ghost"
                    onClick={() => setIsNetWorthModalOpen(true)}
                    type="button"
                  >
                    Details
                  </button>
                </div>
              }
            >
              <LineChart
                points={dashboard.net_worth_trend}
                currency={currency}
                floatingBaseline
                showForecast={showNetWorthForecast}
                showTodayMarker={showForecast}
              />
            </SectionPanel>
            <SectionPanel
              title="Cash flow momentum"
              actions={
                <button
                  className="button button--compact button--ghost"
                  onClick={() => setIsCashFlowModalOpen(true)}
                  type="button"
                >
                  Details
                </button>
              }
            >
              <CashFlowChart
                points={dashboard.cash_flow_components}
                currency={currency}
                showTodayMarker={showForecast}
              />
            </SectionPanel>
          </div>

          <div className="grid">
            <SectionPanel
              title="Expense mix"
              actions={
                <button
                  className="button button--compact button--ghost"
                  onClick={() => setIsExpenseMixModalOpen(true)}
                  type="button"
                >
                  Details
                </button>
              }
            >
              <div
                className="chart-stat-grid chart-stat-grid--compact expense-mix-stats"
                aria-label="Expense mix summary"
              >
                <div>
                  <span>Average</span>
                  <strong>{fmtCurrency(expenseStats.average, currency)}</strong>
                </div>
                <div>
                  <span>Average deviation</span>
                  <strong>
                    {fmtCurrency(expenseStats.averageDeviation, currency)}
                  </strong>
                </div>
              </div>
              <StackedBarChart
                points={expenseMix?.trend ?? []}
                categories={expenseCategories}
                currency={currency}
                selectedCategory={selectedExpenseCategory}
                onCategorySelect={(label) =>
                  setSelectedExpenseCategory((current) =>
                    current === label ? null : label,
                  )
                }
                showTodayMarker={showForecast}
              />
            </SectionPanel>
          </div>

          <div className="grid grid--two">
            <SectionPanel
              title="Loans & mortgages"
              eyebrow={`${visibleLoans.length} shown / ${loans.length} accounts`}
              actions={
                paidOffLoanCount ? (
                  <button
                    className="button button--compact button--ghost"
                    onClick={() => setShowPaidOffLoans((value) => !value)}
                    type="button"
                  >
                    {showPaidOffLoans
                      ? "Hide paid off"
                      : `Show paid off (${paidOffLoanCount})`}
                  </button>
                ) : null
              }
            >
              {visibleLoans.length ? (
                <div className="property-loans">
                  {visibleLoans.map((loan) => (
                    <LoanSummaryCard
                      key={loan.id}
                      loan={loan}
                      currency={currency}
                      onOpenLoan={setSelectedLoan}
                    />
                  ))}
                </div>
              ) : (
                <EmptyState
                  title={
                    loans.length ? "Paid off loans hidden" : "No loans imported"
                  }
                  body={
                    loans.length
                      ? "Use the toggle to include closed accounts."
                      : "Loan data appears here after import."
                  }
                />
              )}
            </SectionPanel>

            <SectionPanel
              title="Properties"
              eyebrow={`${properties.length} ${properties.length === 1 ? "property" : "properties"}`}
            >
              {properties.length ? (
                <div className="asset-card-grid">
                  {properties.map((asset) => (
                    <button
                      className="asset-card"
                      key={asset.id}
                      onClick={() =>
                        onNavigateToProjects
                          ? onNavigateToProjects(asset.id)
                          : setSelectedAsset(asset)
                      }
                      type="button"
                    >
                      <span>{asset.name}</span>
                      <strong>{fmtCurrency(asset.total_cost, currency)}</strong>
                      <small>
                        {assetRooms(asset).length
                          ? `${assetRooms(asset).length} ${assetRooms(asset).length === 1 ? "category" : "categories"}`
                          : "No breakdown"}
                      </small>
                    </button>
                  ))}
                </div>
              ) : (
                <EmptyState
                  title="No properties yet"
                  body="Add a property on the Properties page or import asset data."
                />
              )}
            </SectionPanel>
          </div>

          <div className="grid grid--two">
            <SectionPanel
              title="Savings allocation"
              actions={
                <button
                  className="button button--compact button--ghost"
                  onClick={() => setIsSavingsModalOpen(true)}
                  type="button"
                >
                  Details
                </button>
              }
            >
              <DonutChart
                items={dashboard.savings_allocation}
                currency={currency}
              />
            </SectionPanel>
            <SectionPanel
              title="Money flow"
              actions={
                <button
                  className="button button--compact button--ghost"
                  onClick={() => setIsFlowModalOpen(true)}
                  type="button"
                >
                  Details
                </button>
              }
            >
              <SankeyChart
                incomes={dashboard.income_breakdown}
                expenses={dashboard.expense_breakdown}
                cashFlow={dashboard.cash_flow_trend}
                currency={currency}
              />
            </SectionPanel>
          </div>
        </div>
      ) : null}

      <button
        className="quick-add-fab overview-quick-add-fab"
        onClick={() => setIsQuickAddOpen(true)}
        type="button"
        aria-label="Add record"
      >
        <Plus className="h-6 w-6" />
      </button>

      {isQuickAddOpen ? (
        <QuickAddRecordModal
          categories={categories}
          expenseGroups={expenseGroups}
          expenseRows={expenseBoardRows}
          properties={properties}
          onClose={() => setIsQuickAddOpen(false)}
          onAdded={load}
        />
      ) : null}

      {selectedLoan ? (
        <LoanDetailModal
          loan={selectedLoan}
          properties={properties}
          onClose={() => setSelectedLoan(null)}
          onSaved={(updated) => {
            setLoans((current) =>
              current.map((loan) => loan.id === updated.id ? updated : loan),
            );
            setSelectedLoan(updated);
          }}
        />
      ) : null}

      {selectedAsset ? (
        <PropertyDetailModal
          key={selectedAsset.id}
          property={selectedAsset}
          projects={assets.filter((item) => item.kind === "project")}
          categories={categories}
          currency={currency}
          saving={propertyMutations.saving}
          onClose={() => setSelectedAsset(null)}
          onSave={propertyMutations.save}
          onCreateOwnCategory={propertyMutations.createOwnCategory}
          onListValuations={listValuations}
          onAddValuation={addValuation}
          onDeleteValuation={removeValuation}
          onLinkProject={linkProject}
          onUnlinkProject={unlinkProject}
          onListUtilityFields={listUtilityFields}
          onTrackUtilityField={trackUtilityField}
          onUntrackUtilityField={untrackUtilityField}
        />
      ) : null}

      {isCashFlowModalOpen && dashboard ? (
        <Modal
          className="net-worth-modal cash-flow-modal cash-flow-detail-modal"
          headerClassName="net-worth-modal__header"
          title={
            <>
              Cash flow details{" "}
              <span className="net-worth-modal__currency">{currency}</span>
            </>
          }
          titleId="cash-flow-detail-title"
          onClose={() => setIsCashFlowModalOpen(false)}
          actions={
            <button
              aria-label="Close"
              className="nw-close net-worth-modal__close"
              onClick={() => setIsCashFlowModalOpen(false)}
              type="button"
            >
              x
            </button>
          }
        >
          <div className="overview-details">
            <div className="overview-stat-row overview-stat-row--mobile-inline">
              <div>
                <span>Total income</span>
                <strong className="is-positive">
                  {fmtCurrency(
                    dashboard.cash_flow_components.reduce(
                      (sum, point) => sum + point.income,
                      0,
                    ),
                    currency,
                  )}
                </strong>
              </div>
              <div>
                <span>Total expenses</span>
                <strong className="is-negative">
                  {fmtCurrency(
                    dashboard.cash_flow_components.reduce(
                      (sum, point) => sum + point.expenses,
                      0,
                    ),
                    currency,
                  )}
                </strong>
              </div>
              <div>
                <span>Net cash flow</span>
                <strong
                  className={
                    sumValues(dashboard.cash_flow_trend) >= 0
                      ? "is-positive"
                      : "is-negative"
                  }
                >
                  {fmtCurrency(sumValues(dashboard.cash_flow_trend), currency)}
                </strong>
              </div>
            </div>

            <MonthTableShell className="net-worth-table-shell cash-flow-table-shell">
              <table className="net-worth-table cash-flow-detail-table">
                <thead>
                  <tr>
                    <th>M</th>
                    <th>Income</th>
                    <th>Expenses</th>
                    <th>Net</th>
                  </tr>
                </thead>
                {groupRowsByYear(
                  [...dashboard.cash_flow_components].reverse(),
                  (point) => point.period,
                ).map((group) => (
                  <tbody key={group.year}>
                    <YearDividerRow columns={4} year={group.year} />
                    {group.rows.map((point) => (
                      <tr key={point.period}>
                        <th>{monthNumberLabel(point.period)}</th>
                        <td>{fmtNumber(point.income)}</td>
                        <td>{fmtNumber(point.expenses)}</td>
                        <td
                          className={point.net >= 0 ? "is-positive" : "is-negative"}
                        >
                          {fmtNumber(point.net)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                ))}
              </table>
            </MonthTableShell>
          </div>
        </Modal>
      ) : null}

      {isExpenseMixModalOpen && dashboard ? (
        <Modal
          className="net-worth-modal overview-detail-modal"
          headerClassName="net-worth-modal__header"
          title="Expense mix details"
          titleId="expense-mix-detail-title"
          onClose={() => setIsExpenseMixModalOpen(false)}
          actions={
            <button
              aria-label="Close"
              className="nw-close net-worth-modal__close"
              onClick={() => setIsExpenseMixModalOpen(false)}
              type="button"
            >
              x
            </button>
          }
        >
          <div className="overview-details">
            <div className="overview-stat-row overview-stat-row--mobile-inline">
              <div>
                <span>Total spend</span>
                <strong>
                  {fmtCurrency(sumValues(selectedExpenseBreakdown), currency)}
                </strong>
              </div>
              <div>
                <span>Categories</span>
                <strong>{selectedExpenseBreakdown.length}</strong>
              </div>
              <div>
                <span>Largest share</span>
                <strong>
                  {selectedExpenseBreakdown[0]
                    ? `${(selectedExpenseBreakdown[0].share * 100).toFixed(1)}%`
                    : "0%"}
                </strong>
              </div>
            </div>
            <div className="detail-table">
              {expenseCategories.map((item) => (
                <button
                  aria-pressed={selectedExpenseCategory === item.label}
                  className={`detail-row detail-row--button ${selectedExpenseCategory === item.label ? "is-active" : ""}`}
                  key={item.label}
                  onClick={() =>
                    setSelectedExpenseCategory((current) =>
                      current === item.label ? null : item.label,
                    )
                  }
                  type="button"
                >
                  <span>{item.label}</span>
                  <strong>{fmtCurrency(item.value, currency)}</strong>
                  <small>{(item.share * 100).toFixed(1)}%</small>
                </button>
              ))}
            </div>
          </div>
        </Modal>
      ) : null}

      {isSavingsModalOpen && dashboard ? (
        <Modal
          className="net-worth-modal overview-detail-modal"
          headerClassName="net-worth-modal__header"
          title="Savings allocation details"
          titleId="savings-detail-title"
          onClose={() => setIsSavingsModalOpen(false)}
          actions={
            <button
              aria-label="Close"
              className="nw-close net-worth-modal__close"
              onClick={() => setIsSavingsModalOpen(false)}
              type="button"
            >
              x
            </button>
          }
        >
          <div className="overview-details">
            <div className="overview-stat-row overview-stat-row--mobile-inline">
              <div>
                <span>Total balance</span>
                <strong>
                  {fmtCurrency(sumValues(dashboard.savings_allocation), currency)}
                </strong>
              </div>
              <div>
                <span>Allocations</span>
                <strong>{dashboard.savings_allocation.length}</strong>
              </div>
              <div>
                <span>Largest bucket</span>
                <strong>
                  {dashboard.savings_allocation[0]?.label ?? "None"}
                </strong>
              </div>
            </div>
            <div className="detail-table">
              {dashboard.savings_allocation.map((item) => (
                <div className="detail-row" key={item.label}>
                  <span>{item.label}</span>
                  <strong>{fmtCurrency(item.value, currency)}</strong>
                  <small>{(item.share * 100).toFixed(1)}%</small>
                </div>
              ))}
            </div>
          </div>
        </Modal>
      ) : null}

      {isFlowModalOpen && dashboard ? (
        <Modal
          className="net-worth-modal overview-detail-modal"
          headerClassName="net-worth-modal__header"
          title="Money flow details"
          titleId="flow-detail-title"
          onClose={() => setIsFlowModalOpen(false)}
          actions={
            <button
              aria-label="Close"
              className="nw-close net-worth-modal__close"
              onClick={() => setIsFlowModalOpen(false)}
              type="button"
            >
              x
            </button>
          }
        >
          <div className="overview-details">
            <div className="detail-table">
              {dashboard.income_breakdown.map((item) => (
                <div className="detail-row" key={`income-${item.label}`}>
                  <span>{item.label}</span>
                  <strong className="is-positive">
                    {fmtCurrency(item.value, currency)}
                  </strong>
                  <small>Income</small>
                </div>
              ))}
              {dashboard.expense_breakdown.map((item) => (
                <div className="detail-row" key={`expense-${item.label}`}>
                  <span>{item.label}</span>
                  <strong className="is-negative">
                    {fmtCurrency(item.value, currency)}
                  </strong>
                  <small>Spending</small>
                </div>
              ))}
              <div className="detail-row">
                <span>Net cash flow</span>
                <strong>
                  {fmtCurrency(sumValues(dashboard.cash_flow_trend), currency)}
                </strong>
                <small>{dashboard.cash_flow_trend.length} months</small>
              </div>
            </div>
          </div>
        </Modal>
      ) : null}

      {isNetWorthModalOpen && dashboard ? (
        <DetailModal
          className="net-worth-modal net-worth-detail-modal"
          title="Net worth details"
          currency={currency}
          titleId="net-worth-detail-title"
          onClose={() => setIsNetWorthModalOpen(false)}
          options={
            <DetailActionsMenu
              label="Table options"
              placement="start"
              actions={[{
                label: "Add month",
                onClick: () => setSelectedNetWorthMonth(draftNetWorthMonth(nextNetWorthMonth(dashboard.net_worth_components.map((row) => row.period), new Date(), session?.household.timezone), dashboard.net_worth_components)),
              }]}
              toggles={[{
                label: "Heat",
                checked: isNetWorthHeatEnabled,
                onChange: setIsNetWorthHeatEnabled,
              }]}
            />
          }
        >
          <MonthTableShell>
            <table className="net-worth-table">
              <thead>
                <tr>
                  <th>M</th>
                  <th>Value</th>
                  {NET_WORTH_GROUPS.map((group) => (
                    <th key={group.key}>{group.label}</th>
                  ))}
                </tr>
              </thead>
              {groupRowsByYear(
                [...dashboard.net_worth_components].reverse(),
                (row) => row.period,
              ).map((yearGroup) => (
                <tbody key={yearGroup.year}>
                  <YearDividerRow
                    columns={2 + NET_WORTH_GROUPS.length}
                    year={yearGroup.year}
                  />
                  {yearGroup.rows.map((row) => renderNetWorthMonthRow(row))}
                </tbody>
              ))}
            </table>
          </MonthTableShell>
        </DetailModal>
      ) : null}
      {selectedNetWorthMonth ? (
        <NetWorthMonthEditor key={selectedNetWorthMonth.period}
          row={dashboard?.net_worth_components.find((row) => row.period === selectedNetWorthMonth.period) ?? selectedNetWorthMonth}
          onPeriodChange={(period) => setSelectedNetWorthMonth(dashboard?.net_worth_components.find((row) => row.period === period) ?? draftNetWorthMonth(period, dashboard?.net_worth_components ?? []))}
          onClose={() => setSelectedNetWorthMonth(null)} onSaved={() => setSelectedNetWorthMonth(null)} />
      ) : null}
    </>
  );
}
