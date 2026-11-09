import { useState } from "react";
import { Plus } from "lucide-react";
import { DetailModal } from "../../components/DetailModal";
import { DetailActionsMenu } from "../../components/DetailActionsMenu";
import { LoanPayoffChart } from "../../components/charts";
import {
  groupRowsByYear,
  MonthTableShell,
  monthNumberLabel,
  YearDividerRow,
} from "../../components/MonthTable";
import {
  fmtNumber,
  formatRawValue,
  numericAmount,
} from "../../lib/format";
import { useSession } from "../../lib/session";
import type { AssetSummary } from "../../contracts/assets";
import type { LoanSummary } from "../../contracts/dashboard";
import { LoanEditor } from "./LoanEditor";
import { LoanPaymentEditor } from "./LoanPaymentEditor";
import { LoanProgress } from "./LoanProgress";
import { LoanNotesCard } from "./LoanNotesCard";
import {
  finiteLoanNumber,
  loanPaymentCompleted,
  loanPaymentSchedule,
  loanTotalInterest,
} from "./model";

type LoanDetailView = "summary" | "table";

const friendlyText = (value: string) =>
  value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());

const DETAIL_LABELS: Record<string, string> = {
  fixed_monthly_payment: "Formula fixed payment",
  monthly_payment: "Planned monthly payment",
  monthly_interest_rate: "Monthly interest rate",
  period_count: "Period count",
  loan_amount: "Loan amount",
  source_sheet: "Source sheet",
};

const detailLabel = (value: string) =>
  DETAIL_LABELS[value] ?? friendlyText(value);

const detailEntries = (
  details: Record<string, unknown> | undefined,
  excluded: string[],
) =>
  Object.entries(details ?? {}).filter(([key, value]) => {
    if (excluded.includes(key)) {
      return false;
    }
    return value !== null && value !== undefined && value !== "";
  });

type LoanDetailModalProps = {
  loan: LoanSummary;
  properties: AssetSummary[];
  onClose: () => void;
  onSaved?: (loan: LoanSummary) => void;
};

export function LoanDetailModal(props: LoanDetailModalProps) {
  return <LoanDetailContent key={props.loan.id} {...props} />;
}

function LoanDetailContent({
  loan,
  properties,
  onClose,
  onSaved,
}: LoanDetailModalProps) {
  const { currency } = useSession();
  const [editingLoanId, setEditingLoanId] = useState<string | null>(null);
  const [loanDetailView, setLoanDetailView] = useState<LoanDetailView>("summary");
  const [includeForecast, setIncludeForecast] = useState(true);
  const [editingPayment, setEditingPayment] = useState<{ index: number | null } | null>(null);
  // Keep successful edits visible even when the caller does not need a save callback.
  // A refreshed loan prop takes precedence over this local edit result.
  const [savedLoan, setSavedLoan] = useState<{
    source: LoanSummary;
    value: LoanSummary;
  } | null>(null);
  const selectedLoan = savedLoan?.source === loan ? savedLoan.value : loan;
  const selectedLoanSchedule = loanPaymentSchedule(selectedLoan);
  const visibleLoanSchedule = selectedLoanSchedule.filter(
    (payment) => includeForecast || !payment.projected,
  );
  const selectedLoanPeriods = finiteLoanNumber(
    selectedLoan.details?.period_count,
  );

  return (
    <>
      <DetailModal
        className={`drive-picker asset-detail-modal loan-detail-modal${
          loanDetailView === "table" ? " loan-detail-modal--table" : ""
        }`}
        title={selectedLoan.name}
        currency={currency}
        titleId="loan-detail-title"
        closeLabel="Close loan details"
        onClose={onClose}
        options={
          <DetailActionsMenu label="Loan actions" placement="start" actions={[
            { label: "Edit", disabled: editingLoanId !== null, onClick: () => setEditingLoanId(selectedLoan.id) },
          ]} toggles={editingLoanId !== selectedLoan.id && selectedLoanSchedule.length ? [
            { label: "Forecast", checked: includeForecast, onChange: setIncludeForecast },
          ] : []} />
        }
      >
        {editingLoanId === selectedLoan.id ? (
          <LoanEditor
            key={selectedLoan.id}
            loan={selectedLoan}
            properties={properties}
            onCancel={() => setEditingLoanId(null)}
            onSaved={(updated) => {
              setSavedLoan({ source: loan, value: updated });
              setEditingLoanId(null);
              onSaved?.(updated);
            }}
          />
        ) : (
          <>
            <div
              className="view-toggle loan-detail-tabs"
              aria-label="Loan detail view"
              role="tablist"
            >
              {(["summary", "table"] as const).map((view) => (
                <button
                  aria-controls={`loan-${view}-panel`}
                  aria-selected={loanDetailView === view}
                  className={loanDetailView === view ? "is-active" : ""}
                  key={view}
                  onClick={() => setLoanDetailView(view)}
                  role="tab"
                  type="button"
                >
                  {view === "summary" ? "Summary" : "Table"}
                </button>
              ))}
            </div>
            {loanDetailView === "summary" ? (
              <div
                className="loan-summary-panel"
                id="loan-summary-panel"
                role="tabpanel"
              >
                <LoanProgress loan={selectedLoan} currency={currency} totalInterest={loanTotalInterest(selectedLoan)} />
                <div className="detail-table">
                  {selectedLoanPeriods !== null && selectedLoanPeriods > 0 ? (
                    <div className="detail-row">
                      <span>Periods</span>
                      <strong>{Math.round(selectedLoanPeriods)}</strong>
                    </div>
                  ) : null}
                  {detailEntries(selectedLoan.details, [
                    "loan_name",
                    "name",
                    "current_balance",
                    "balance",
                    "monthly_payment",
                    "fixed_monthly_payment",
                    "payment",
                    "interest_rate",
                    "monthly_interest_rate",
                    "original_balance",
                    "loan_amount",
                    "start_date",
                    "end_date",
                    "source_sheet",
                    "notes",
                    "payment_schedule",
                    "_current_balance_as_of",
                  ]).map(([key, value]) => (
                    <div className="detail-row" key={key}>
                      <span>{detailLabel(key)}</span>
                      <strong>{formatRawValue(key, value, currency)}</strong>
                    </div>
                  ))}
                </div>
                {visibleLoanSchedule.length ? (
                  <div className="loan-summary-graph">
                    <LoanPayoffChart
                      payments={visibleLoanSchedule}
                      currency={currency}
                    />
                  </div>
                ) : null}
                {selectedLoan.notes ? (
                  <LoanNotesCard notes={selectedLoan.notes} />
                ) : null}
              </div>
            ) : (
              <div
                className="loan-outlook-panel"
                id="loan-table-panel"
                role="tabpanel"
              >
                <MonthTableShell className="net-worth-table-shell">
                  <table className="net-worth-table loan-schedule-table">
                    <thead>
                      <tr>
                        <th>M</th>
                        <th>Payment</th>
                        <th>Interest</th>
                        <th>Principal</th>
                        <th>Extra principal</th>
                        <th>Balance</th>
                      </tr>
                    </thead>
                    {!visibleLoanSchedule.length ? (
                      <tbody>
                        <tr><td colSpan={6}>{selectedLoanSchedule.length ? 'No recorded payments. Disable Forecast to hide projected payments.' : 'No payments yet. Add a row to start the table.'}</td></tr>
                      </tbody>
                    ) : null}
                    {groupRowsByYear(visibleLoanSchedule, (payment) =>
                      payment.date.slice(0, 7),
                    ).map((group) => (                      <tbody key={group.year}>
                        <YearDividerRow columns={6} year={group.year} />
                        {group.rows.map((payment, index) => (
                          <tr key={payment.id ?? `${payment.date}-${index}`}
                            className={`loan-schedule-table__row${loanPaymentCompleted(payment) ? " loan-schedule-table__row--completed" : ""}`} tabIndex={0}
                            aria-label={`Edit payment ${payment.date}`}
                            onClick={() => setEditingPayment({ index: selectedLoanSchedule.indexOf(payment) })}
                            onKeyDown={(event) => {
                              if (event.key === "Enter" || event.key === " ") {
                                event.preventDefault();
                                setEditingPayment({ index: selectedLoanSchedule.indexOf(payment) });
                              }
                            }}>
                            <th>{monthNumberLabel(payment.date.slice(0, 7))}</th>
                            <td>{fmtNumber(numericAmount(payment.payment))}</td>
                            <td>{fmtNumber(numericAmount(payment.interest))}</td>
                            <td>{fmtNumber(numericAmount(payment.principal))}</td>
                            <td>
                              {fmtNumber(numericAmount(payment.extra_principal))}
                            </td>
                            <td>
                              {fmtNumber(
                                numericAmount(payment.outstanding_loan_balance),
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    ))}
                    <tbody>
                      <tr className="loan-schedule-table__add-row">
                        <td colSpan={6}>
                          <button className="loan-table__label loan-table__add" type="button" onClick={() => setEditingPayment({ index: null })}>
                            <Plus aria-hidden="true" className="h-3 w-3" />
                            Add row
                          </button>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </MonthTableShell>
              </div>
            )}
          </>
        )}
      </DetailModal>
      {editingPayment ? (
        <LoanPaymentEditor loan={selectedLoan} rowIndex={editingPayment.index}
          onCancel={() => setEditingPayment(null)}
          onSaved={(updated) => {
            setSavedLoan({ source: loan, value: updated });
            setEditingPayment(null);
            onSaved?.(updated);
          }} />
      ) : null}
    </>
  );
}
