import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  groupRowsByYear,
  monthNumberLabel,
  YearDividerRow,
} from "./MonthTable";

describe("MonthTable", () => {
  it("groups consecutive display rows by year", () => {
    const rows = [
      { period: "2026-02" },
      { period: "2026-01" },
      { period: "2025-12" },
      { period: "2025-11" },
    ];

    expect(groupRowsByYear(rows, (row) => row.period)).toEqual([
      { year: "2026", rows: rows.slice(0, 2) },
      { year: "2025", rows: rows.slice(2) },
    ]);
  });

  it("renders month numbers without their period year", () => {
    expect(monthNumberLabel("2026-09")).toBe("9");
    expect(monthNumberLabel("2025-12")).toBe("12");
    expect(monthNumberLabel("unparseable")).toBe("unparseable");
  });

  it("renders an accessible divider row spanning every table column", () => {
    render(
      <table>
        <tbody>
          <YearDividerRow columns={4} year="2025" />
        </tbody>
      </table>,
    );

    expect(screen.getByRole("columnheader", { name: "2025" })).toHaveAttribute(
      "colspan",
      "4",
    );
  });
});
