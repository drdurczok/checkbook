import { useMemo, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { useHeaderListbox } from "../lib/use-header-listbox";

export type HeaderSelectOption = { value: string; label: string };
export type HeaderSelectGroup = { label?: string; options: HeaderSelectOption[] };

/**
 * Plain centered header label with a chevron that opens a listbox menu.
 * Used for the topbar subject pickers (properties, utilities) so the header
 * reads as text rather than a form control. The menu mirrors the shared
 * date-range filter behavior: arrows move between options, Escape and
 * outside pointer presses dismiss, and the trigger regains focus.
 */
export function HeaderSelect({
	ariaLabel,
	value,
	groups,
	onChange,
	placeholder,
	menuAlign = "center",
	triggerClassName,
	separatorGroups = false,
}: {
	ariaLabel: string;
	value: string;
	groups: HeaderSelectGroup[];
	onChange: (next: string) => void;
	placeholder?: string;
	/** Centered menus suit title-like triggers; start-aligned menus suit
	 * triggers with room to their right; end-aligned menus hug the
	 * trigger's right edge so they never spill past a right panel edge. */
	menuAlign?: "center" | "start" | "end";
	/** Extra classes for the trigger button, e.g. to dress it as a panel
	 * action button while keeping the header-select behavior. */
	triggerClassName?: string;
	/** Render a thin separator line between groups instead of the labeled
	 * group headers. Empty groups are skipped so dividers never stack. */
	separatorGroups?: boolean;
}) {
	const [open, setOpen] = useState(false);
	const shellRef = useRef<HTMLDivElement | null>(null);
	const triggerRef = useRef<HTMLButtonElement | null>(null);
	const menuRef = useRef<HTMLDivElement | null>(null);
	const { focusTrigger, handleTriggerKeyDown, handleMenuKeyDown } =
		useHeaderListbox({ open, setOpen, shellRef, triggerRef, menuRef });

	const selectedLabel = useMemo(
		() =>
			groups
				.flatMap((group) => group.options)
				.find((option) => option.value === value)?.label ??
			placeholder ??
			"",
		[groups, placeholder, value],
	);

	const select = (next: string) => {
		if (next !== value) {
			onChange(next);
		}
		setOpen(false);
		focusTrigger();
	};

	return (
		<div className="app-header-select-shell relative" ref={shellRef}>
			<button
				ref={triggerRef}
				aria-expanded={open}
				aria-haspopup="listbox"
				aria-label={ariaLabel}
				className={`app-header-select${triggerClassName ? ` ${triggerClassName}` : ""}`}
				onClick={() => setOpen((next) => !next)}
				onKeyDown={handleTriggerKeyDown}
				title={ariaLabel}
				type="button"
			>
				<span className="app-header-select__label">{selectedLabel}</span>
				<ChevronDown aria-hidden="true" className="h-4 w-4" />
			</button>
			{open ? (
				<div
					aria-label={ariaLabel}
					className={`app-filter-menu modal-shell ghost-outline absolute top-full z-50 mt-3 w-60 overflow-hidden p-2${menuAlign === "start" ? " app-filter-menu--start" : menuAlign === "end" ? " app-filter-menu--end" : ""}`}
					onKeyDown={handleMenuKeyDown}
					ref={menuRef}
					role="listbox"
				>
					{(separatorGroups
						? groups.filter((group) => group.options.length > 0)
						: groups
					).map((group, groupIndex) => (
						<div key={group.label ?? `group-${groupIndex}`}>
							{separatorGroups ? (
								groupIndex > 0 ? (
									<div className="app-filter-menu__divider" role="separator" />
								) : null
							) : group.label ? (
								<div aria-hidden="true" className="app-filter-group">
									{group.label}
								</div>
							) : null}
							{group.options.map((option) => (
								<button
									aria-selected={option.value === value}
									className="app-filter-option"
									key={option.value}
									onClick={() => select(option.value)}
									role="option"
									type="button"
								>
									<span>{option.label}</span>
									{option.value === value ? (
										<Check aria-hidden="true" className="h-4 w-4" />
									) : null}
								</button>
							))}
						</div>
					))}
				</div>
			) : null}
		</div>
	);
}
