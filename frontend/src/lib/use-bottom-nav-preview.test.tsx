import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRef } from "react";
import { useBottomNavPreview } from "./use-bottom-nav-preview";

/**
 * Minimal harness mirroring how `App.tsx` mounts the bottom nav: a `<nav>` with
 * `data-nav-label` buttons, the capture-phase click guard, and the rendered
 * preview bubble.
 */
function Harness({ onNavigate }: { onNavigate: (key: string) => void }) {
	const ref = useRef<HTMLElement | null>(null);
	const preview = useBottomNavPreview(ref);
	return (
		<>
			<nav ref={ref} onClickCapture={preview.onClickCapture}>
				<button
					data-nav-label="Alpha"
					onClick={() => onNavigate("alpha")}
					type="button"
				>
					A
				</button>
				<button
					data-nav-label="Beta"
					onClick={() => onNavigate("beta")}
					type="button"
				>
					B
				</button>
			</nav>
			{preview.state ? (
				<span data-testid="preview">{preview.state.label}</span>
			) : null}
		</>
	);
}

describe("useBottomNavPreview", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		// jsdom does not implement elementFromPoint; install a controllable mock.
		document.elementFromPoint = vi
			.fn<(x: number, y: number) => Element | null>()
			.mockReturnValue(null);
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("reveals the label only after holding, tracks the finger, and hides on release", async () => {
		const onNavigate = vi.fn();
		render(<Harness onNavigate={onNavigate} />);
		const nav = screen.getByRole("navigation");
		const [alpha, beta] = screen.getAllByRole("button");
		vi.mocked(document.elementFromPoint).mockImplementation((x) =>
			x < 50 ? alpha : beta,
		);

		// Press: no label until the hold threshold elapses.
		fireEvent.touchStart(nav, { touches: [{ clientX: 10, clientY: 10 }] });
		expect(screen.queryByTestId("preview")).toBeNull();

		// Hold elapses -> Alpha is under the finger.
		await act(async () => {
			vi.advanceTimersByTime(350);
		});
		expect(screen.getByTestId("preview")).toHaveTextContent("Alpha");

		// Slide the finger over Beta -> label follows.
		fireEvent.touchMove(nav, { touches: [{ clientX: 60, clientY: 10 }] });
		expect(screen.getByTestId("preview")).toHaveTextContent("Beta");

		// Lift the finger -> label disappears.
		fireEvent.touchEnd(nav);
		expect(screen.queryByTestId("preview")).toBeNull();
		expect(onNavigate).not.toHaveBeenCalled();
	});

	it("suppresses the synthetic click after a preview gesture so releasing does not navigate", async () => {
		const onNavigate = vi.fn();
		render(<Harness onNavigate={onNavigate} />);
		const nav = screen.getByRole("navigation");
		const beta = screen.getAllByRole("button")[1];
		vi.mocked(document.elementFromPoint).mockImplementation(() => beta);

		fireEvent.touchStart(nav, { touches: [{ clientX: 60, clientY: 10 }] });
		await act(async () => {
			vi.advanceTimersByTime(350);
		});
		fireEvent.touchEnd(nav);

		// The browser fires a click after touchend; it must be swallowed.
		fireEvent.click(beta);
		expect(onNavigate).not.toHaveBeenCalled();
	});

	it("still navigates on a quick tap that never engages preview", () => {
		const onNavigate = vi.fn();
		render(<Harness onNavigate={onNavigate} />);
		const nav = screen.getByRole("navigation");
		const alpha = screen.getAllByRole("button")[0];
		vi.mocked(document.elementFromPoint).mockImplementation(() => alpha);

		fireEvent.touchStart(nav, { touches: [{ clientX: 10, clientY: 10 }] });
		// No hold elapsed -> quick tap.
		fireEvent.touchEnd(nav);
		fireEvent.click(alpha);
		expect(onNavigate).toHaveBeenCalledWith("alpha");
	});

	it("does not engage when the press does not start on a labeled button", async () => {
		const onNavigate = vi.fn();
		render(<Harness onNavigate={onNavigate} />);
		const nav = screen.getByRole("navigation");
		vi.mocked(document.elementFromPoint).mockImplementation(
			() => document.body,
		);

		fireEvent.touchStart(nav, { touches: [{ clientX: 5, clientY: 5 }] });
		await act(async () => {
			vi.advanceTimersByTime(1000);
		});
		expect(screen.queryByTestId("preview")).toBeNull();
	});
});
