import { useEffect, useRef } from "react";
import type {
	KeyboardEvent as ReactKeyboardEvent,
	RefObject,
} from "react";

const FOCUSABLE = [
	"a[href]",
	"button:not([disabled])",
	"input:not([disabled])",
	"select:not([disabled])",
	"textarea:not([disabled])",
	"[tabindex]:not([tabindex=\"-1\"])",
].join(",");

// Every mounted dialog registers its close callback here. Only the topmost
// entry reacts to Escape, so stacked dialogs (e.g. an invoice builder opened
// over its income-source editor, or a menu inside a dialog) close one layer at
// a time instead of all dismissing on a single key press.
const dialogEscapeStack: Array<() => void> = [];

/**
 * Shared modal-dialog keyboard behavior: initial focus placement, focus
 * restoration on unmount, and stack-aware Escape dismissal. `dialogRef` must
 * reference the `role="dialog"` element; pair it with `keepFocusInDialog` on
 * the same element for Tab wrapping.
 */
export function useDialogBehavior(
	dialogRef: RefObject<HTMLElement | null>,
	onClose: () => void,
) {
	const onCloseRef = useRef(onClose);

	useEffect(() => {
		onCloseRef.current = onClose;
	}, [onClose]);

	useEffect(() => {
		const dialog = dialogRef.current;
		const previouslyFocused =
			document.activeElement instanceof HTMLElement
				? document.activeElement
				: null;
		const firstFocusable =
			dialog?.querySelector<HTMLElement>("[autofocus]") ??
			dialog?.querySelector<HTMLElement>(FOCUSABLE);
		;(firstFocusable ?? dialog)?.focus({ preventScroll: true });

		const close = () => onCloseRef.current();
		dialogEscapeStack.push(close);
		const closeOnEscape = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			if (dialogEscapeStack[dialogEscapeStack.length - 1] !== close) return;
			event.preventDefault();
			close();
		};
		document.addEventListener("keydown", closeOnEscape);
		return () => {
			dialogEscapeStack.splice(dialogEscapeStack.indexOf(close), 1);
			document.removeEventListener("keydown", closeOnEscape);
			previouslyFocused?.focus({ preventScroll: true });
		};
		// The dialog element and close identity are stable for a mount; the
		// latest onClose is read through onCloseRef.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);
}

/** Wraps Tab focus inside the dialog element this handler is attached to. */
export function keepFocusInDialog(event: ReactKeyboardEvent<HTMLElement>) {
	if (event.key !== "Tab") return;
	const focusable = Array.from(
		event.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE),
	);
	if (!focusable.length) {
		event.preventDefault();
		event.currentTarget.focus();
		return;
	}
	const first = focusable[0];
	const last = focusable[focusable.length - 1];
	if (event.shiftKey && document.activeElement === first) {
		event.preventDefault();
		last.focus();
	} else if (!event.shiftKey && document.activeElement === last) {
		event.preventDefault();
		first.focus();
	}
}
