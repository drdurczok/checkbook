import { useEffect } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, RefObject } from "react";

type HeaderListboxRefs = {
	open: boolean;
	setOpen: (value: boolean) => void;
	shellRef: RefObject<HTMLDivElement | null>;
	triggerRef: RefObject<HTMLButtonElement | null>;
	menuRef: RefObject<HTMLDivElement | null>;
};

/**
 * Shared behavior for the small topbar listbox menus (date range filter,
 * header subject select): outside-pointer dismissal, arrow navigation
 * between options, Escape from both the trigger and the open menu, and
 * focus restoration to the trigger. The trigger keeps focus while the
 * menu is closed and options take focus while it is open.
 */
export function useHeaderListbox({
	open,
	setOpen,
	shellRef,
	triggerRef,
	menuRef,
}: HeaderListboxRefs) {
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
	}, [open, setOpen, shellRef]);

	const focusTrigger = () => {
		triggerRef.current?.focus();
	};

	const focusOption = (index: number) => {
		const options = menuRef.current?.querySelectorAll<HTMLButtonElement>(
			'[role="option"]',
		);
		if (!options || options.length === 0) {
			return;
		}
		options[(index + options.length) % options.length].focus();
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
				'[role="option"]',
			) ?? [],
		);
		const index = options.indexOf(
			document.activeElement as HTMLButtonElement,
		);
		focusOption(
			event.key === "ArrowDown" ? index + 1 : index === -1 ? 0 : index - 1,
		);
	};

	return {
		focusTrigger,
		focusOption,
		handleTriggerKeyDown,
		handleMenuKeyDown,
	};
}
