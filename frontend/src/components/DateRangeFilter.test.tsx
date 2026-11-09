import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DateRangeFilter } from "./DateRangeFilter";

describe("DateRangeFilter", () => {
	it("toggles Forecast independently of every date option and Retired", async () => {
		const user = userEvent.setup();
		const onChange = vi.fn();
		const onForecast = vi.fn();
		const onRetired = vi.fn();
		const view = render(<DateRangeFilter value="6m" onChange={onChange} forecastFilter={{ checked: false, onChange: onForecast }} retiredFilter={{ checked: false, onChange: onRetired }} />);
		const trigger = screen.getByRole("button", { name: "Date range" });
		await user.click(trigger);
		expect(trigger).toHaveAttribute("aria-haspopup", "dialog");
		expect(screen.queryByRole("option", { name: "Forecast" })).not.toBeInTheDocument();
		expect(screen.getByRole("option", { name: "6 months" })).toHaveAttribute("aria-selected", "true");
		const toggle = screen.getByRole("switch", { name: "Forecast" });
		const toggleGroup = screen.getByRole("group", { name: "Display options" });
		expect(toggleGroup).toHaveClass("app-filter-toggles");
		expect(within(toggleGroup).getAllByRole("switch")).toHaveLength(2);
		expect(toggle).not.toHaveClass("app-filter-toggles");
		expect(screen.getByRole("switch", { name: "Retired" })).not.toHaveClass("app-filter-toggles");
		screen.getByRole("option", { name: "All time" }).focus();
		await user.keyboard("{ArrowDown}");
		expect(toggle).toHaveFocus();
		await user.keyboard(" ");
		expect(onForecast).toHaveBeenCalledWith(true);
		expect(onChange).not.toHaveBeenCalled();
		expect(onRetired).not.toHaveBeenCalled();
		view.rerender(<DateRangeFilter value="6m" onChange={onChange} forecastFilter={{ checked: true, onChange: onForecast }} retiredFilter={{ checked: false, onChange: onRetired }} />);
		expect(toggle).toHaveAttribute("aria-checked", "true");
		await user.keyboard("{ArrowDown}");
		expect(screen.getByRole("switch", { name: "Retired" })).toHaveFocus();
		await user.click(screen.getByRole("option", { name: "Current month" }));
		expect(onChange).toHaveBeenCalledWith("month");
		await user.click(trigger);
		expect(screen.getByRole("switch", { name: "Forecast" })).toHaveAttribute("aria-checked", "true");
		await user.click(screen.getByRole("switch", { name: "Forecast" }));
		expect(onForecast).toHaveBeenLastCalledWith(false);
	});

	it("adds Retired as the last keyboard-accessible toggle without changing the range", async () => {
		const user = userEvent.setup();
		const onChange = vi.fn();
		const onRetiredChange = vi.fn();
		const view = render(<DateRangeFilter value="all" onChange={onChange} retiredFilter={{ checked: false, onChange: onRetiredChange }} />);
		await user.click(screen.getByRole("button", { name: "Date range" }));
		const toggle = screen.getByRole("switch", { name: "Retired" });
		expect(toggle).toHaveAttribute("aria-checked", "false");
		const lastOption = screen.getAllByRole("option").at(-1);
		lastOption?.focus();
		await user.keyboard("{ArrowDown}");
		expect(toggle).toHaveFocus();
		await user.keyboard(" ");
		expect(onRetiredChange).toHaveBeenCalledWith(true);
		expect(onChange).not.toHaveBeenCalled();
		view.rerender(<DateRangeFilter value="all" onChange={onChange} retiredFilter={{ checked: true, onChange: onRetiredChange }} />);
		expect(toggle).toHaveAttribute("aria-checked", "true");
		await user.click(toggle);
		expect(onRetiredChange).toHaveBeenLastCalledWith(false);
		await user.keyboard("{Escape}");
		expect(screen.queryByRole("switch")).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Date range" })).toHaveFocus();
	});

	it("opens a named listbox from the circular trigger", async () => {
		const user = userEvent.setup();
		render(<DateRangeFilter value="all" onChange={() => {}} />);

		const trigger = screen.getByRole("button", { name: "Date range" });
		expect(trigger).toHaveAttribute("aria-haspopup", "listbox");
		expect(trigger).toHaveAttribute("aria-expanded", "false");

		await user.click(trigger);
		const menu = screen.getByRole("listbox", { name: "Date range" });
		expect(trigger).toHaveAttribute("aria-expanded", "true");
		expect(
			within(menu).getByRole("option", { name: "All time" }),
		).toHaveAttribute("aria-selected", "true");
	});

	it("selects a range, closes the menu, and restores trigger focus", async () => {
		const user = userEvent.setup();
		const onChange = vi.fn();
		render(<DateRangeFilter value="all" onChange={onChange} />);

		const trigger = screen.getByRole("button", { name: "Date range" });
		await user.click(trigger);
		await user.click(screen.getByRole("option", { name: "12 months" }));

		expect(onChange).toHaveBeenCalledWith("12m");
		expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
		expect(trigger).toHaveFocus();
	});

	it("keeps the current value without emitting a change", async () => {
		const user = userEvent.setup();
		const onChange = vi.fn();
		render(<DateRangeFilter value="6m" onChange={onChange} />);

		await user.click(screen.getByRole("button", { name: "Date range" }));
		await user.click(screen.getByRole("option", { name: "6 months" }));

		expect(onChange).not.toHaveBeenCalled();
		expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
	});

	it("supports arrow navigation and Escape dismissal", async () => {
		const user = userEvent.setup();
		render(<DateRangeFilter value="all" onChange={() => {}} />);

		const trigger = screen.getByRole("button", { name: "Date range" });
		await user.keyboard("{ArrowDown}");
		expect(trigger).toHaveAttribute("aria-expanded", "false");

		trigger.focus();
		await user.keyboard("{ArrowDown}");
		const options = screen.getAllByRole("option");
		await waitFor(() => expect(options[0]).toHaveFocus());

		await user.keyboard("{ArrowDown}");
		await waitFor(() => expect(options[1]).toHaveFocus());

		await user.keyboard("{Escape}");
		expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
		expect(trigger).toHaveFocus();
	});

	it("closes from the trigger with Escape", async () => {
		const user = userEvent.setup();
		render(<DateRangeFilter value="all" onChange={() => {}} />);

		const trigger = screen.getByRole("button", { name: "Date range" });
		await user.click(trigger);
		expect(screen.getByRole("listbox", { name: "Date range" })).toBeVisible();

		await user.keyboard("{Escape}");
		expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
		expect(trigger).toHaveFocus();
	});
});
