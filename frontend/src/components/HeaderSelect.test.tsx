import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { HeaderSelect } from "./HeaderSelect";

const groups = [
	{
		label: "Properties",
		options: [
			{ value: "property:1", label: "Vacation home" },
			{ value: "property:2", label: "City flat" },
		],
	},
	{
		options: [
			{ value: "", label: "All properties" },
			{ value: "__new__", label: "+ New property" },
		],
	},
];

describe("HeaderSelect", () => {
	it("shows the selected label with a chevron and opens a named listbox", async () => {
		const user = userEvent.setup();
		render(
			<HeaderSelect
				ariaLabel="Property"
				groups={groups}
				value="property:1"
				onChange={() => {}}
			/>,
		);

		const trigger = screen.getByRole("button", { name: "Property" });
		expect(trigger).toHaveTextContent("Vacation home");
		expect(trigger).toHaveAttribute("aria-haspopup", "listbox");
		expect(trigger).toHaveAttribute("aria-expanded", "false");

		await user.click(trigger);
		const menu = screen.getByRole("listbox", { name: "Property" });
		expect(trigger).toHaveAttribute("aria-expanded", "true");
		expect(
			within(menu).getByRole("option", { name: "Vacation home" }),
		).toHaveAttribute("aria-selected", "true");
	});

	it("falls back to the placeholder when nothing is selected", () => {
		render(
			<HeaderSelect
				ariaLabel="Property or contract"
				groups={groups}
				placeholder="No property"
				value="property:missing"
				onChange={() => {}}
			/>,
		);

		expect(screen.getByRole("button", { name: "Property or contract" })).toHaveTextContent(
			"No property",
		);
	});

	it("selects an option, closes the menu, and restores trigger focus", async () => {
		const user = userEvent.setup();
		const onChange = vi.fn();
		render(
			<HeaderSelect
				ariaLabel="Property"
				groups={groups}
				value="property:1"
				onChange={onChange}
			/>,
		);

		const trigger = screen.getByRole("button", { name: "Property" });
		await user.click(trigger);
		await user.click(screen.getByRole("option", { name: "City flat" }));

		expect(onChange).toHaveBeenCalledWith("property:2");
		expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
		expect(trigger).toHaveFocus();
	});

	it("keeps the current value without emitting a change", async () => {
		const user = userEvent.setup();
		const onChange = vi.fn();
		render(
			<HeaderSelect
				ariaLabel="Property"
				groups={groups}
				value="property:1"
				onChange={onChange}
			/>,
		);

		await user.click(screen.getByRole("button", { name: "Property" }));
		await user.click(screen.getByRole("option", { name: "Vacation home" }));

		expect(onChange).not.toHaveBeenCalled();
		expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
	});

	it("supports arrow navigation across groups and Escape dismissal", async () => {
		const user = userEvent.setup();
		render(
			<HeaderSelect
				ariaLabel="Property"
				groups={groups}
				value="property:1"
				onChange={() => {}}
			/>,
		);

		const trigger = screen.getByRole("button", { name: "Property" });
		await user.keyboard("{ArrowDown}");
		expect(trigger).toHaveAttribute("aria-expanded", "false");

		trigger.focus();
		await user.keyboard("{ArrowDown}");
		const options = screen.getAllByRole("option");
		await waitFor(() => expect(options[0]).toHaveFocus());

		await user.keyboard("{ArrowDown}");
		await waitFor(() => expect(options[1]).toHaveFocus());
		await user.keyboard("{ArrowDown}");
		await waitFor(() => expect(options[2]).toHaveFocus());

		await user.keyboard("{Escape}");
		expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
		expect(trigger).toHaveFocus();
	});

	it("closes from the trigger with Escape", async () => {
		const user = userEvent.setup();
		render(
			<HeaderSelect
				ariaLabel="Property"
				groups={groups}
				value="property:1"
				onChange={() => {}}
			/>,
		);

		const trigger = screen.getByRole("button", { name: "Property" });
		await user.click(trigger);
		expect(screen.getByRole("listbox", { name: "Property" })).toBeVisible();

		await user.keyboard("{Escape}");
		expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
		expect(trigger).toHaveFocus();
	});
});

describe("HeaderSelect separator groups", () => {
	const separatorModeGroups = [
		{ options: [{ value: "", label: "All assets" }] },
		{
			label: "Properties",
			options: [{ value: "property:1", label: "Vacation home" }],
		},
		{
			label: "Vehicles",
			options: [{ value: "vehicle:1", label: "Family car" }],
		},
		{ options: [] },
		{ options: [{ value: "__new__", label: "+ New asset" }] },
	];

	it("separates groups with real separators instead of text headers", async () => {
		const user = userEvent.setup();
		render(
			<HeaderSelect
				ariaLabel="Asset"
				groups={separatorModeGroups}
				separatorGroups
				value=""
				onChange={() => {}}
			/>,
		);

		await user.click(screen.getByRole("button", { name: "Asset" }));
		const menu = screen.getByRole("listbox", { name: "Asset" });
		expect(within(menu).getAllByRole("option")).toHaveLength(4);
		expect(within(menu).getAllByRole("separator")).toHaveLength(3);
		expect(menu.querySelector(".app-filter-menu__divider")).not.toBeNull();
		// Group labels never render as text headers in this mode, and the
		// empty group leaves no stacked divider behind.
		expect(menu.querySelector(".app-filter-group")).toBeNull();
		expect(within(menu).getByRole("option", { name: "Family car" })).toBeInTheDocument();
	});

	it("keeps arrow navigation walking every option in DOM order", async () => {
		const user = userEvent.setup();
		render(
			<HeaderSelect
				ariaLabel="Asset"
				groups={separatorModeGroups}
				separatorGroups
				value=""
				onChange={() => {}}
			/>,
		);

		const trigger = screen.getByRole("button", { name: "Asset" });
		trigger.focus();
		await user.keyboard("{ArrowDown}");
		const options = screen.getAllByRole("option");
		await waitFor(() => expect(options[0]).toHaveFocus());
		await user.keyboard("{ArrowDown}");
		await waitFor(() => expect(options[1]).toHaveFocus());
		await user.keyboard("{ArrowDown}");
		await waitFor(() => expect(options[2]).toHaveFocus());
		await user.keyboard("{ArrowDown}");
		await waitFor(() => expect(options[3]).toHaveFocus());
		await user.keyboard("{ArrowDown}");
		await waitFor(() => expect(options[0]).toHaveFocus());
	});

	it("keeps labeled group headers in the default mode", async () => {
		const user = userEvent.setup();
		render(
			<HeaderSelect
				ariaLabel="Property"
				groups={groups}
				value="property:1"
				onChange={() => {}}
			/>,
		);

		await user.click(screen.getByRole("button", { name: "Property" }));
		const menu = screen.getByRole("listbox", { name: "Property" });
		expect(within(menu).getByText("Properties")).toBeInTheDocument();
		expect(within(menu).queryAllByRole("separator")).toHaveLength(0);
	});
});
