import { useEffect, useRef, useState } from "react";

/**
 * Press-and-hold preview for the mobile bottom navigation.
 *
 * On touch devices the bottom nav buttons only show an icon. Holding a finger
 * on the nav reveals a floating label above the bar with the title of the
 * button under the finger; sliding left/right moves the label to whichever
 * button is currently under the finger, and lifting the finger hides it.
 *
 * The hold is a deliberate gesture: a quick tap never enters preview mode, so
 * normal navigation still fires. When a preview gesture ends, the synthesized
 * click that follows `touchend` is suppressed so releasing does not navigate.
 */
const HOLD_DELAY_MS = 350;
const NAV_LABEL_ATTR = "data-nav-label";

export interface BottomNavPreviewState {
	label: string;
	/** Horizontal center (viewport px) of the button under the finger. */
	originX: number;
}

export interface BottomNavPreview {
	/** Current preview state, or `null` when the label is hidden. */
	state: BottomNavPreviewState | null;
	/** Attach to the nav element to swallow the post-preview synthetic click. */
	onClickCapture: (event: React.MouseEvent<HTMLElement>) => void;
}

interface Probe {
	label: string;
	originX: number;
}

function probeAtPoint(x: number, y: number): Probe | null {
	const element = document.elementFromPoint(x, y) as Element | null;
	const labeled = element?.closest<HTMLElement>(`[${NAV_LABEL_ATTR}]`) ?? null;
	const label = labeled?.dataset.navLabel;
	if (!labeled || !label) {
		return null;
	}
	const rect = labeled.getBoundingClientRect();
	return { label, originX: rect.left + rect.width / 2 };
}

/**
 * @param navRef Ref attached to the bottom-nav `<nav>` element.
 */
export function useBottomNavPreview(
	navRef: React.RefObject<HTMLElement | null>,
): BottomNavPreview {
	const [state, setState] = useState<BottomNavPreviewState | null>(null);
	const previewing = useRef(false);
	const suppressClick = useRef(false);
	const holdTimer = useRef<number | null>(null);
	const lastPoint = useRef<{ x: number; y: number } | null>(null);

	useEffect(() => {
		const node = navRef.current;
		if (!node) {
			return;
		}

		const clearHold = () => {
			if (holdTimer.current !== null) {
				window.clearTimeout(holdTimer.current);
				holdTimer.current = null;
			}
		};

		const apply = (point: { x: number; y: number }) => {
			const probe = probeAtPoint(point.x, point.y);
			setState(probe ? { label: probe.label, originX: probe.originX } : null);
		};

		const onTouchStart = (event: TouchEvent) => {
			const touch = event.touches[0];
			if (!touch) {
				return;
			}
			const point = { x: touch.clientX, y: touch.clientY };
			lastPoint.current = point;
			previewing.current = false;
			suppressClick.current = false;
			clearHold();
			// Only engage when the press begins on a labeled nav button.
			if (probeAtPoint(point.x, point.y) === null) {
				return;
			}
			holdTimer.current = window.setTimeout(() => {
				previewing.current = true;
				const current = lastPoint.current;
				if (current) {
					apply(current);
				}
			}, HOLD_DELAY_MS);
		};

		const onTouchMove = (event: TouchEvent) => {
			const touch = event.touches[0];
			if (!touch) {
				return;
			}
			lastPoint.current = { x: touch.clientX, y: touch.clientY };
			if (previewing.current) {
				event.preventDefault();
				apply(lastPoint.current);
			}
		};

		const endPreview = () => {
			clearHold();
			const wasPreviewing = previewing.current;
			previewing.current = false;
			lastPoint.current = null;
			setState(null);
			if (wasPreviewing) {
				// The browser fires a synthetic `click` after `touchend`; suppress it so
				// releasing after a preview does not also navigate.
				suppressClick.current = true;
				window.setTimeout(() => {
					suppressClick.current = false;
				}, HOLD_DELAY_MS);
			}
		};

		node.addEventListener("touchstart", onTouchStart, { passive: true });
		// `touchmove` is non-passive so we can preventDefault (stop page scroll) once
		// a preview drag is in progress.
		node.addEventListener("touchmove", onTouchMove, { passive: false });
		node.addEventListener("touchend", endPreview, { passive: true });
		node.addEventListener("touchcancel", endPreview, { passive: true });

		return () => {
			clearHold();
			node.removeEventListener("touchstart", onTouchStart);
			node.removeEventListener("touchmove", onTouchMove);
			node.removeEventListener("touchend", endPreview);
			node.removeEventListener("touchcancel", endPreview);
		};
	}, [navRef]);

	const onClickCapture = (event: React.MouseEvent<HTMLElement>) => {
		if (suppressClick.current) {
			suppressClick.current = false;
			event.preventDefault();
			event.stopPropagation();
		}
	};

	return { state, onClickCapture };
}
