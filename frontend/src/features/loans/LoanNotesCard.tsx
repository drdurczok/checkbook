import { useState } from "react";
import { ChevronDown } from "lucide-react";

/** Loan notes collapse into their own card below the chart. The card only
 * renders when the loan actually carries notes. */
export function LoanNotesCard({ notes }: { notes: string }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="loan-notes-card">
      <button
        aria-controls="loan-notes-body"
        aria-expanded={open}
        className="loan-notes-card__toggle"
        id="loan-notes-toggle"
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        Notes
        <ChevronDown aria-hidden="true" className="loan-notes-card__chevron" />
      </button>
      <div
        aria-labelledby="loan-notes-toggle"
        className="loan-notes-card__body"
        hidden={!open}
        id="loan-notes-body"
      >
        {notes}
      </div>
    </div>
  );
}
