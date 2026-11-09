import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { Check, SlidersHorizontal } from "lucide-react";
import { FilterToggle } from "./FilterToggle";
import { DATE_RANGE_OPTIONS } from "../lib/format";
import type { DateRangeKey } from "../lib/format";

/**
 * Circular topbar filter that picks the shared dashboard date range.
 * The trigger keeps focus while the listbox is open; arrows move between
 * options, Escape and outside pointer presses dismiss.
 */
export function DateRangeFilter({
	value,
	onChange,
	forecastFilter,
	retiredFilter,
}: {
	value: DateRangeKey;
	onChange: (next: DateRangeKey) => void;
	forecastFilter?: { checked: boolean; onChange: (checked: boolean) => void };
	retiredFilter?: { checked: boolean; onChange: (checked: boolean) => void };
}) {
	const [open, setOpen] = useState(false);
	const shellRef = useRef<HTMLDivElement | null>(null);
	const triggerRef = useRef<HTMLButtonElement | null>(null);
	const menuRef = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		if (!open) {
			return;
		}
		const close = (event: PointerEvent) => {
			if (
				event.target instanceof Node &&
				shellRef.current?.contains(event.target)
			) {
				return;
			}
			setOpen(false);
		};
		document.addEventListener("pointerdown", close);
		return () => document.removeEventListener("pointerdown", close);
	}, [open]);

	const focusTrigger = () => {
		triggerRef.current?.focus();
	};

	const focusOption = (index: number) => {
		const options = menuRef.current?.querySelectorAll<HTMLButtonElement>(
			'[role="option"], [role="switch"]',
		);
		if (!options || options.length === 0) {
			return;
		}
		options[(index + options.length) % options.length].focus();
	};

	const select = (next: DateRangeKey) => {
		if (next !== value) {
			onChange(next);
		}
		setOpen(false);
		focusTrigger();
	};

	const handleTriggerKeyDown = (
		event: ReactKeyboardEvent<HTMLButtonElement>,
	) => {
		if (event.key === "Escape" && open) {
			event.preventDefault();
			setOpen(false);
			return;
		}
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			setOpen(true);
			window.requestAnimationFrame(() =>
				focusOption(event.key === "ArrowUp" ? -1 : 0),
			);
		}
	};

	const handleMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
		if (event.key === "Escape") {
			event.preventDefault();
			setOpen(false);
			focusTrigger();
			return;
		}
		if (event.key !== "ArrowDown" && event.key !== "ArrowUp") {
			return;
		}
		event.preventDefault();
		const options = Array.from(
			menuRef.current?.querySelectorAll<HTMLButtonElement>(
				'[role="option"], [role="switch"]',
			) ?? [],
		);
		const index = options.indexOf(
			document.activeElement as HTMLButtonElement,
		);
		focusOption(
			event.key === "ArrowDown" ? index + 1 : index === -1 ? 0 : index - 1,
		);
	};

	return (
		<div className="app-filter-shell relative" ref={shellRef}>
			<button
				ref={triggerRef}
				aria-expanded={open}
				aria-haspopup={forecastFilter || retiredFilter ? "dialog" : "listbox"}
				aria-label="Date range"
				className="app-filter-button"
				onClick={() => setOpen((next) => !next)}
				onKeyDown={handleTriggerKeyDown}
				title="Date range"
				type="button"
			>
				<SlidersHorizontal aria-hidden="true" className="h-4 w-4" />
			</button>
			{open ? (
				<div
					aria-label="Date range"
					className="app-filter-menu modal-shell ghost-outline absolute right-0 top-full z-50 mt-3 w-56 overflow-hidden p-2"
					onKeyDown={handleMenuKeyDown}
					ref={menuRef}
					role={forecastFilter || retiredFilter ? "dialog" : "listbox"}
				>
					<div role={forecastFilter || retiredFilter ? "listbox" : undefined} aria-label={forecastFilter || retiredFilter ? "Date range" : undefined}>
					{DATE_RANGE_OPTIONS.map((option) => (
						<button
							aria-selected={option.key === value}
							className="app-filter-option"
							key={option.key}
							onClick={() => select(option.key)}
							role="option"
							type="button"
						>
							<span>{option.label}</span>
							{option.key === value ? (
								<Check aria-hidden="true" className="h-4 w-4" />
							) : null}
						</button>
					))}
					</div>
					{forecastFilter || retiredFilter ? (
						<div className="app-filter-toggles" role="group" aria-label="Display options">
							{forecastFilter ? <FilterToggle label="Forecast" {...forecastFilter} /> : null}
							{retiredFilter ? <FilterToggle label="Retired" {...retiredFilter} /> : null}
						</div>
					) : null}
				</div>
			) : null}
		</div>
	);
}
