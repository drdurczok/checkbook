import { expect, test } from "@playwright/test";

export const session = {
  token: "e2e-token",
  expires_at: "2099-01-01T00:00:00Z",
  user: {
    id: "user-1",
    email: "owner@example.com",
    full_name: "Test Owner",
    picture_url: "",
  },
  household: {
    id: "house-1",
    name: "Test Household",
    base_currency: "PLN",
    timezone: "Europe/Warsaw",
  },
  membership: { id: "membership-1", role: "owner", relationship_kind: "owner" },
  settings: {
    id: "settings-1",
    privacy_mode: "household",
    allow_cross_member_visibility: true,
    projection_baseline_window_months: 12,
    projection_horizon_months: 24,
    savings_allocation_strategy: "default",
    role_permissions: {},
  },
};

export const dashboardOverview = {
  metrics: [],
  net_worth_trend: [],
  net_worth_components: [],
  cash_flow_trend: [],
  cash_flow_components: [],
  income_breakdown: [],
  expense_breakdown: [
    { label: "Fixed", value: 300, share: 0.75 },
    { label: "Fun stuff", value: 100, share: 0.25 },
  ],
  expense_trend_by_category: [
    { period: "2026-01", values: { Fixed: 300, "Fun stuff": 100 } },
  ],
  utility_trend: [],
  savings_allocation: [],
  loans: [],
  upcoming_planned_expenses: [],
  recent_activity: [],
  goals: [],
  last_successful_import: null,
};

test("overview starts flush and the quick-add chrome stays flat", async ({
  page,
}) => {
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("response", (response) => {
    if (response.status() >= 400) browserErrors.push(`${response.status()} ${response.url()}`);
  });
  await page.route("http://127.0.0.1:4174/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/auth/session") {
      await route.fulfill({ json: session });
      return;
    }
    if (path === "/api/household/settings") {
      await route.fulfill({ json: session.settings });
      return;
    }
    if (path === "/api/dashboard/overview") {
      await route.fulfill({ json: dashboardOverview });
      return;
    }
    if (path === "/api/household/expenses/board") {
      await route.fulfill({ json: { groups: [], categories: [], monthly_totals: [] } });
      return;
    }
    await route.fulfill({ json: [] });
  });
  await page.addInitScript(() =>
    window.localStorage.setItem("checkbook.session", "e2e-token"),
  );
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Net worth" })).toBeVisible();

  // Desktop overview panels have no horizontal section dividers.
  const borders = await page.evaluate(() => {
    const stack = document.querySelector(".page-stack");
    const first = [...(stack?.firstElementChild?.querySelectorAll(".panel") ?? [])].map(
      (panel) => getComputedStyle(panel).borderTopWidth,
    );
    const later = [...(stack?.children ?? [])]
      .slice(1)
      .flatMap((child) =>
        child instanceof HTMLElement
          ? [...child.querySelectorAll(".panel")]
          : [],
      )
      .map((panel) => getComputedStyle(panel).borderTopWidth);
    return { first, later };
  });
  expect(borders.first).toEqual(["0px", "0px"]);
  expect(borders.later.length).toBeGreaterThan(0);
  borders.later.forEach((width) => expect(width).toBe("0px"));

  // Side-by-side overview panels have no vertical dividers either.
  const pair = await page.evaluate(() => {
    const grid = document.querySelector(".page-stack > :first-child.grid--two");
    const panels = grid ? [...grid.querySelectorAll(":scope > .panel")] : [];
    return panels.map((panel) => getComputedStyle(panel).borderLeftWidth);
  });
  expect(pair).toEqual(["0px", "0px"]);

  // Secondary panel actions (like Cash flow momentum's Details) render as
  // white ghost buttons, not accent-filled primaries.
  const detailsBackground = await page.evaluate(() => {
    const panel = [...document.querySelectorAll(".panel")].find((candidate) =>
      candidate.querySelector("h2")?.textContent?.includes("Cash flow"),
    );
    const button = panel?.querySelector(".panel__actions button");
    return button ? getComputedStyle(button).backgroundColor : null;
  });
  expect(detailsBackground).toBe("rgb(255, 255, 255)");

  for (const width of [768, 1280, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    const frame = await page.locator(".app-content").evaluate((content) => {
      const box = content.getBoundingClientRect();
      const sidebar = document.querySelector(".app-sidebar")!;
      const topbar = document.querySelector(".app-topbar")!;
      return {
        left: box.left, right: box.right, bottom: box.bottom, top: box.top,
        sidebarRight: sidebar.getBoundingClientRect().right,
        topbarBottom: topbar.getBoundingClientRect().bottom,
        radius: getComputedStyle(content).borderRadius,
        shadow: getComputedStyle(content).boxShadow,
        overflow: getComputedStyle(content).overflowY,
        headerBorder: getComputedStyle(topbar).borderBottomWidth,
        sidebarBorder: getComputedStyle(sidebar).borderRightWidth,
        headerBackground: getComputedStyle(topbar).backgroundColor,
        sidebarBackground: getComputedStyle(sidebar).backgroundColor,
        shellBackground: getComputedStyle(document.querySelector(".app-shell")!).backgroundColor,
      };
    });
    expect(frame.right).toBe(width - 12);
    expect(frame.bottom).toBe(888);
    expect(frame.left).toBe(frame.sidebarRight);
    expect(frame.top).toBe(frame.topbarBottom);
    expect(frame.radius).toBe("12px");
    expect(frame.shadow).not.toBe("none");
    expect(frame.overflow).toBe("auto");
    expect(frame.headerBorder).toBe("0px");
    expect(frame.sidebarBorder).toBe("0px");
    expect(frame.headerBackground).toBe(frame.sidebarBackground);
    expect(frame.headerBackground).toBe(frame.shellBackground);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBe(900);
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({ path: "test-results/workspace-desktop.png" });
  const scroll = await page.locator(".app-content").evaluate((content) => {
    content.scrollTop = content.scrollHeight;
    const box = content.getBoundingClientRect();
    return { scrollTop: content.scrollTop, top: box.top, bottom: box.bottom };
  });
  expect(scroll.scrollTop).toBeGreaterThan(0);
  expect(scroll.top).toBe(64);
  expect(scroll.bottom).toBe(888);
  await page.locator(".app-content").evaluate((content) => { content.scrollTop = 0; });
  await page.locator(".app-sidebar-toggle").click();
  await expect(page.locator(".app-content")).toHaveCSS("margin-left", "256px");
  await page.screenshot({ path: "test-results/workspace-desktop-expanded.png" });
  await page.locator(".app-sidebar-toggle").click();

  for (const width of [320, 390, 767]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(page.locator(".app-content")).toHaveCSS("border-radius", "6px");
    await expect(page.locator(".app-topbar")).toHaveCSS("border-bottom-width", "0px");
    await expect(page.locator(".app-bottom-nav")).toHaveCSS("border-top-width", "0px");
    await expect(page.locator(".app-content")).toHaveCSS("margin-left", "0px");
    const frame = await page.locator(".app-content").evaluate((content) => {
      const header = document.querySelector(".app-topbar")!;
      const footer = document.querySelector(".app-bottom-nav")!;
      const box = content.getBoundingClientRect();
      return {
        top: box.top, bottom: box.bottom, left: box.left, right: box.right,
        clientWidth: content.clientWidth,
        headerBottom: header.getBoundingClientRect().bottom,
        footerTop: footer.getBoundingClientRect().top,
        shadow: getComputedStyle(content).boxShadow,
        background: getComputedStyle(content).backgroundColor,
        headerBackground: getComputedStyle(header).backgroundColor,
        footerBackground: getComputedStyle(footer).backgroundColor,
        shellBackground: getComputedStyle(document.querySelector(".app-shell")!).backgroundColor,
      };
    });
    expect(frame.top).toBe(frame.headerBottom + 4);
    expect(frame.bottom).toBeCloseTo(frame.footerTop - 4, 1);
    expect(frame.left).toBe(0);
    expect(frame.right).toBe(width);
    // No reserved scrollbar track: the workspace stays symmetric, so page
    // content centers instead of hugging the left edge.
    expect(Math.round(frame.right - frame.left)).toBe(frame.clientWidth);
    expect(frame.shadow).not.toBe("none");
    expect(frame.headerBackground).toBe(frame.footerBackground);
    expect(frame.headerBackground).toBe(frame.shellBackground);
    expect(frame.background).not.toBe(frame.headerBackground);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBe(844);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "test-results/workspace-mobile.png" });
  await page.locator(".app-content").evaluate((content) => { content.scrollTop = 240; });
  await expect(page.locator(".app-shell")).toHaveClass(/mobile-chrome-hidden/);
  await expect.poll(async () => page.locator(".app-content").evaluate((content) => {
    const box = content.getBoundingClientRect();
    return { top: box.top, bottom: box.bottom };
  })).toEqual({ top: 4, bottom: 840 });
  await page.locator(".app-content").evaluate(async (content) => {
    // Slow upward adjustments must leave both bars hidden.
    for (let step = 0; step < 5; step++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      content.scrollTop -= 10;
    }
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  await expect(page.locator(".app-shell")).toHaveClass(/mobile-chrome-hidden/);
  await page.locator(".app-content").evaluate(async (content) => {
    content.scrollTop += 20;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    content.scrollTop -= 64;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  await expect(page.locator(".app-shell")).toHaveClass(/mobile-chrome-hidden/);
  // Even a fast gesture and the last few pixels before the top keep both bars hidden.
  await page.locator(".app-content").evaluate(async (content) => {
    content.scrollTop = 1;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  await expect.poll(() => page.locator(".app-content").evaluate((content) => content.scrollTop)).toBe(1);
  await expect(page.locator(".app-shell")).toHaveClass(/mobile-chrome-hidden/);
  await page.screenshot({ path: "test-results/workspace-mobile-scrolled.png" });
  await page.locator(".app-content").evaluate((content) => { content.scrollTop = 0; });
  await expect(page.locator(".app-shell")).not.toHaveClass(/mobile-chrome-hidden/);
  await page.setViewportSize({ width: 1280, height: 900 });

  // The quick-add footer and form surfaces are flat: no gradient image, and
  // the footer matches the modal background color.
  await page.getByRole("button", { name: "Add record" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  const chrome = await dialog.evaluate((node) => {
    const footer = node.querySelector(".quick-add-actions");
    const form = node.querySelector(".quick-add-form");
    return {
      footerImage: footer ? getComputedStyle(footer).backgroundImage : null,
      footerColor: footer ? getComputedStyle(footer).backgroundColor : null,
      formImage: form ? getComputedStyle(form).backgroundImage : null,
    };
  });
  expect(chrome.footerImage).toBe("none");
  expect(chrome.footerColor).toBe("rgb(255, 255, 255)");
  expect(chrome.formImage).toBe("none");
  expect(browserErrors).toEqual([]);
});

test("detail tables show month numbers beneath sticky year dividers", async ({
  page,
}) => {
  // Two full modals, 36 months of expansion, and scroll pinning in one test:
  // mark slow so shared CI runners get 3x the default timeout.
  test.slow();
  // Three full years so the table scrolls far enough to pin and hand over
  // years (the last year alone is shorter than the scroll viewport).
  const netWorthMonths: { period: string; total: number }[] = [];
  for (const year of [2024, 2025, 2026]) {
    for (let month = 12; month >= 1; month -= 1) {
      netWorthMonths.push({
        period: `${year}-${String(month).padStart(2, "0")}`,
        total: year * 1000 + month,
      });
    }
  }
  const detailDashboard = {
    ...dashboardOverview,
    net_worth_components: netWorthMonths.map((row) => ({
      ...row,
      growth: 0.1,
      investing: {
        total: 0,
        components: {
          "Index funds": 410,
          "Employer retirement pre-tax match": 260,
        },
      },
      savings: {
        total: row.total,
        components: { "Emergency fund": 330, "House fund": 220 },
      },
      non_liquid_assets: { total: 450000, components: {}, automatic_components: { "Family home": 450000, "Zero property": 0 } },
      debt: { total: 1500, components: {}, automatic_components: { Mortgage: 1500 } },
    })),
    cash_flow_components: Array.from({ length: 36 }, (_, i) => {
      const year = 2024 + Math.floor(i / 12);
      const month = 12 - (i % 12);
      return { period: `${year}-${String(month).padStart(2, "0")}`, income: 1000, expenses: 500, net: 500 };
    }),
  };
  await page.route("http://127.0.0.1:4174/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/auth/session") {
      await route.fulfill({ json: session });
      return;
    }
    if (path === "/api/household/settings") {
      await route.fulfill({ json: session.settings });
      return;
    }
    if (path === "/api/dashboard/overview") {
      await route.fulfill({ json: detailDashboard });
      return;
    }
    if (path === "/api/household/expenses/board") {
      await route.fulfill({ json: { groups: [], categories: [], monthly_totals: [] } });
      return;
    }
    await route.fulfill({ json: [] });
  });
  await page.addInitScript(() =>
    window.localStorage.setItem("checkbook.session", "e2e-token"),
  );
  await page.goto("/");

  await page.getByRole("button", { name: "Details" }).first().click();
  const netWorthDialog = page.locator(".net-worth-detail-modal");
  await expect(netWorthDialog).toBeVisible();
  await expect(netWorthDialog.locator(".net-worth-table__year-row")).toHaveCount(3);
  await expect(netWorthDialog.locator(".net-worth-table__year-row").first()).toHaveText("2026");
  await expect(netWorthDialog.locator(".net-worth-table__summary-row").first()).toContainText("1");
  await expect(netWorthDialog.locator(".net-worth-table__summary-row").first()).not.toContainText("2026-01");

  // Value and growth merged: one "Value" column renders "xxx (±yy.yy%)" with
  // only the percentage colored. Growth arrives as a 100-based index; the cell
  // shows the signed delta from that baseline (0.1 → -99.90%), padded with
  // figure spaces (U+2007, matched by \s) to a fixed width so every row's
  // figures align.
  await expect(netWorthDialog.locator("thead th", { hasText: "Growth" })).toHaveCount(0);
  await expect(
    netWorthDialog.locator(".net-worth-table__summary-row").first().locator("td").first(),
  ).toContainText("(-99.90%)");

  // Currency lives once in the header, never in the table cells.
  await expect(netWorthDialog.locator("h2")).toContainText("PLN");
  await expect(netWorthDialog.locator(".net-worth-table")).not.toContainText("PLN");

  // The header overflow menu holds the heat and expand/collapse controls.
  const optionsTrigger = netWorthDialog.getByRole("button", { name: "Table options" });
  await expect(optionsTrigger).toBeVisible();

  // Unified table-modal header: options far left, title with currency, close.
  const netWorthHeaderOrder = await netWorthDialog.locator(".drive-picker__header").evaluate((element) => {
    const pick = (selector: string) => {
      const box = element.querySelector(selector)!.getBoundingClientRect();
      return { left: box.left, right: box.right, centerY: (box.top + box.bottom) / 2 };
    };
    return {
      options: pick(".nw-options__trigger"),
      title: pick("h2"),
      currency: pick(".net-worth-modal__currency"),
      close: pick(".nw-close"),
      overflow: element.scrollWidth - element.clientWidth,
    };
  });
  expect(netWorthHeaderOrder.options.right).toBeLessThanOrEqual(netWorthHeaderOrder.title.left + 1);
  expect(netWorthHeaderOrder.currency.right).toBeGreaterThan(netWorthHeaderOrder.title.left);
  expect(netWorthHeaderOrder.close.left).toBeGreaterThanOrEqual(netWorthHeaderOrder.currency.right);
  for (const control of [netWorthHeaderOrder.title, netWorthHeaderOrder.close]) {
    expect(Math.abs(control.centerY - netWorthHeaderOrder.options.centerY)).toBeLessThanOrEqual(3);
  }
  expect(netWorthHeaderOrder.overflow).toBeLessThanOrEqual(1);

  await optionsTrigger.click();
  const optionsMenu = netWorthDialog.locator(".nw-options__menu");
  await expect(optionsMenu).toBeVisible();

  await expect(netWorthDialog.getByRole("menuitem", { name: "Expand all" })).toHaveCount(0);
  await netWorthDialog.locator("h2").click();
  await expect(optionsMenu).toBeHidden();
  await netWorthDialog.locator(".net-worth-table__summary-row").first().click();
  const monthEditor = page.getByRole("dialog", { name: "Edit net worth", exact: true });
  await expect(monthEditor).toBeVisible();
  await expect(netWorthDialog.locator(".net-worth-table__detail-row")).toHaveCount(0);
  await expect(monthEditor.getByRole("button", { name: "Save month" })).toBeVisible();
  await expect(monthEditor.getByLabel("Family home automatic value")).toBeVisible();
  await expect(monthEditor.getByLabel("Mortgage automatic value")).toBeVisible();
  await expect(monthEditor.getByText("Zero property")).toHaveCount(0);
  await expect(monthEditor.getByRole("button", { name: "Remove Family home subgroup" })).toHaveCount(0);
  await page.screenshot({ path: '../target/net-worth-editor-desktop.png' });
  const originalViewport = page.viewportSize();
  await page.setViewportSize({ width: 390, height: 844 });
  await monthEditor.evaluate(async (element) => {
    await Promise.all(element.getAnimations().map((animation) => animation.finished));
  });
  await page.screenshot({ path: '../target/net-worth-editor-mobile.png' });
  expect(await monthEditor.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await monthEditor.getByLabel("Mortgage automatic value").scrollIntoViewIfNeeded();
  await page.screenshot({ path: '../target/net-worth-automatic-mobile.png' });
  if (originalViewport) await page.setViewportSize(originalViewport);
  await monthEditor.getByLabel("Mortgage automatic value").scrollIntoViewIfNeeded();
  await page.screenshot({ path: '../target/net-worth-automatic-desktop.png' });
  await monthEditor.getByLabel("Completed", { exact: true }).check();
  await expect(monthEditor.getByRole("button", { name: "Add investing subgroup" })).toBeDisabled();
  await expect(monthEditor.getByLabel("Family home automatic value")).toBeVisible();
  await expect(monthEditor.getByText("Property and loan values are automatic", { exact: false })).toHaveCount(0);
  await expect(monthEditor.getByText("Automatic from", { exact: false })).toHaveCount(0);
  await expect(monthEditor.getByText("Manual values are locked. Untick Completed to edit them.")).toBeVisible();
  for (const row of await monthEditor.locator(".net-worth-editor__automatic").all()) {
    await expect(row).toHaveCSS("border-bottom-width", "0px");
  }
  await monthEditor.getByLabel("Completed", { exact: true }).uncheck();
  await expect(monthEditor.getByRole("button", { name: "Add investing subgroup" })).toBeEnabled();
  const dimensions = await monthEditor.evaluate((element) => ({ width: element.clientWidth, scroll: element.scrollWidth }));
  expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.width + 1);
  await monthEditor.getByRole("button", { name: "Close", exact: true }).click();
  await expect(netWorthDialog).toBeVisible();

  // Scrolling pins the current year right under the sticky header...
  const netWorthShell = netWorthDialog.locator(".net-worth-table-shell");
  const netWorthIndicator = netWorthDialog.locator(".net-worth-table__year-sticky");
  await netWorthShell.evaluate((shell) => {
    shell.scrollTop = 120;
  });
  await expect(netWorthIndicator).toBeVisible();
  await expect(netWorthIndicator).toHaveText("2026");
  // The pinned indicator must end at the table's edge, never past it:
  // MonthTableShell insets its right edge by the shell's scrollbar width
  // (classic browsers) or zero (overlay scrollbars in this runner).
  const indicatorEdges = await netWorthDialog.evaluate((root) => {
    const shell = root.querySelector(".net-worth-table-shell");
    const indicator = root.querySelector(".net-worth-table__year-sticky");
    if (!shell || !indicator) return null;
    const shellRect = shell.getBoundingClientRect();
    return {
      indicatorRight: indicator.getBoundingClientRect().right,
      contentRight: shellRect.left + shell.clientWidth,
    };
  });
  expect(indicatorEdges).not.toBeNull();
  expect(indicatorEdges!.indicatorRight).toBeLessThanOrEqual(
    indicatorEdges!.contentRight + 1,
  );
  const pinnedToHeader = await netWorthDialog.evaluate((root) => {
    const header = root.querySelector("thead th");
    const indicator = root.querySelector(".net-worth-table__year-sticky");
    if (!header || !indicator) return null;
    return Math.abs(
      header.getBoundingClientRect().bottom -
        indicator.getBoundingClientRect().top,
    );
  });
  expect(pinnedToHeader).toBeLessThan(2);

  // The table keeps its padded, bordered box inside the modal — the shell
  // never breaks out edge to edge, whatever width it renders at.
  const netWorthBox = await netWorthDialog.evaluate((root) => {
    const wrap = root.querySelector(".net-worth-table-shell-wrap");
    const shell = root.querySelector(".net-worth-table-shell");
    if (!wrap || !shell) return null;
    return {
      margin: getComputedStyle(wrap).marginLeft,
      width: shell.getBoundingClientRect().width,
      innerWidth: window.innerWidth,
      borderLeft: getComputedStyle(shell).borderLeftWidth,
      radius: getComputedStyle(shell).borderRadius,
    };
  });
  expect(netWorthBox).not.toBeNull();
  expect(netWorthBox!.margin).toBe("0px");
  expect(netWorthBox!.width).toBeLessThan(netWorthBox!.innerWidth);
  expect(netWorthBox!.borderLeft).toBe("1px");
  expect(netWorthBox!.radius).not.toBe("0px");

  // The shell's always-on vertical scrollbar stays slim and transparent
  // tracked so it never reads as a bar overlapping the table.
  const netWorthScrollbar = await netWorthShell.evaluate((shell) => ({
    width: getComputedStyle(shell).scrollbarWidth,
    color: getComputedStyle(shell).scrollbarColor,
  }));
  expect(netWorthScrollbar.width).toBe("thin");
  expect(netWorthScrollbar.color).toContain("rgba(");

  // ...and hands over once the next year's divider reaches it.
  await netWorthShell.evaluate((shell) => {
    shell.scrollTop = shell.scrollHeight;
  });
  await expect(netWorthIndicator).toBeVisible();
  await expect(netWorthIndicator).toHaveText("2025");

  // Back at the top the in-flow divider replaces the floating indicator.
  await netWorthShell.evaluate((shell) => {
    shell.scrollTop = 0;
  });
  await expect(netWorthIndicator).toBeHidden();
  await netWorthDialog.getByRole("button", { name: "Close" }).click();

  await page.getByRole("button", { name: "Details" }).nth(1).click();
  const cashFlowDialog = page.locator(".cash-flow-detail-modal");
  await expect(cashFlowDialog).toBeVisible();
  await expect(cashFlowDialog.locator(".net-worth-table__year-row")).toHaveCount(3);
  await expect(cashFlowDialog.locator(".net-worth-table__year-row").first()).toHaveText("2026");
  await expect(cashFlowDialog.locator("tbody tr").nth(1)).toContainText("1");
  await expect(cashFlowDialog.locator("tbody tr").nth(1)).not.toContainText("2026-01");

  // The cash flow shell must scroll vertically (the modal hands its height
  // down through the stat row wrapper) and pin the year while it does.
  const cashFlowShell = cashFlowDialog.locator(".net-worth-table-shell");
  const cashFlowIndicator = cashFlowDialog.locator(".net-worth-table__year-sticky");
  const cashFlowScrollable = await cashFlowShell.evaluate(
    (shell) => shell.scrollHeight > shell.clientHeight + 10,
  );
  expect(cashFlowScrollable).toBe(true);

  // Same bordered-box rule as net worth: padding and side borders stay.
  const cashFlowBox = await cashFlowDialog.evaluate((root) => {
    const wrap = root.querySelector(".net-worth-table-shell-wrap");
    const shell = root.querySelector(".net-worth-table-shell");
    if (!wrap || !shell) return null;
    return {
      margin: getComputedStyle(wrap).marginLeft,
      borderLeft: getComputedStyle(shell).borderLeftWidth,
      radius: getComputedStyle(shell).borderRadius,
    };
  });
  expect(cashFlowBox).not.toBeNull();
  expect(cashFlowBox!.margin).toBe("0px");
  expect(cashFlowBox!.borderLeft).toBe("1px");
  expect(cashFlowBox!.radius).not.toBe("0px");
  await cashFlowShell.evaluate((shell) => {
    shell.scrollTop = 300;
  });
  await expect(cashFlowIndicator).toBeVisible();
  await expect(cashFlowIndicator).toHaveText("2026");
  await cashFlowShell.evaluate((shell) => {
    shell.scrollTop = 0;
  });
  await expect(cashFlowIndicator).toBeHidden();
});

test("cash flow detail table fits narrow viewports without clipped sides", async ({
  page,
}) => {
  const cashFlow = Array.from({ length: 36 }, (_, i) => {
    const year = 2024 + Math.floor(i / 12);
    const month = 12 - (i % 12);
    return {
      period: `${year}-${String(month).padStart(2, "0")}`,
      income: 123456,
      expenses: 65432,
      net: 58024,
    };
  });
  const dashboard = {
    ...dashboardOverview,
    cash_flow_components: cashFlow,
    cash_flow_trend: cashFlow.map((point) => ({
      period: point.period,
      value: point.net,
    })),
  };
  await page.route("http://127.0.0.1:4174/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/auth/session") {
      await route.fulfill({ json: session });
      return;
    }
    if (path === "/api/household/settings") {
      await route.fulfill({ json: session.settings });
      return;
    }
    if (path === "/api/dashboard/overview") {
      await route.fulfill({ json: dashboard });
      return;
    }
    if (path === "/api/household/expenses/board") {
      await route.fulfill({ json: { groups: [], categories: [], monthly_totals: [] } });
      return;
    }
    await route.fulfill({ json: [] });
  });
  await page.addInitScript(() =>
    window.localStorage.setItem("checkbook.session", "e2e-token"),
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");

  await page.getByRole("button", { name: "Details" }).nth(1).click();
  const modal = page.locator(".cash-flow-detail-modal");
  await expect(modal).toBeVisible();

  // The four columns must fill the shell without overflowing it: the old
  // currency-era min-widths summed 4px past the phone screen, opening a
  // horizontal scroll whose sticky month column clipped the table sides.
  const fit = await modal.evaluate((root) => {
    const shell = root.querySelector(".net-worth-table-shell");
    const table = root.querySelector(".cash-flow-detail-table");
    if (!shell || !table) return null;
    return {
      scrollWidth: shell.scrollWidth,
      clientWidth: shell.clientWidth,
      tableWidth: Math.round(table.getBoundingClientRect().width),
      viewport: window.innerWidth,
    };
  });
  expect(fit).not.toBeNull();
  expect(fit!.scrollWidth).toBeLessThanOrEqual(fit!.clientWidth + 1);
  expect(fit!.tableWidth).toBeLessThanOrEqual(fit!.viewport);

  // A fitting table keeps its bordered box even on a phone...
  const cashFlowBoxed = await modal.evaluate((root) => {
    const wrap = root.querySelector(".net-worth-table-shell-wrap");
    const shell = root.querySelector(".net-worth-table-shell");
    if (!wrap || !shell) return null;
    return {
      margin: getComputedStyle(wrap).marginLeft,
      borderLeft: getComputedStyle(shell).borderLeftWidth,
      fontSize: getComputedStyle(shell.querySelector(".net-worth-table")!).fontSize,
    };
  });
  expect(cashFlowBoxed!.margin).toBe("0px");
  expect(cashFlowBoxed!.borderLeft).toBe("1px");
  // Phone tables share the loans table's compact type size.
  expect(cashFlowBoxed!.fontSize).toBe("10.24px");

  // ...and so does the wider net worth table: the same compact metrics and
  // the bordered shell inside the modal's side padding, never edge to edge.
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Details" }).nth(0).click();
  const netWorthModal = page.locator(".net-worth-detail-modal");
  await expect(netWorthModal).toBeVisible();
  const netWorthBoxed = await netWorthModal.evaluate((root) => {
    const wrap = root.querySelector(".net-worth-table-shell-wrap");
    const shell = root.querySelector(".net-worth-table-shell");
    const table = root.querySelector(".net-worth-table");
    if (!wrap || !shell || !table) return null;
    const box = shell.getBoundingClientRect();
    return {
      margin: getComputedStyle(wrap).marginLeft,
      borderLeft: getComputedStyle(shell).borderLeftWidth,
      fontSize: getComputedStyle(table).fontSize,
      left: box.left,
      right: box.right,
      scrollsX: shell.scrollWidth > shell.clientWidth + 1,
      innerWidth: window.innerWidth,
    };
  });
  expect(netWorthBoxed!.margin).toBe("0px");
  expect(netWorthBoxed!.borderLeft).toBe("1px");
  expect(netWorthBoxed!.fontSize).toBe("10.24px");
  expect(netWorthBoxed!.left).toBeGreaterThan(0);
  expect(netWorthBoxed!.right).toBeLessThan(netWorthBoxed!.innerWidth);
  // The compact metrics let the net worth table fit the phone shell too.
  expect(netWorthBoxed!.scrollsX).toBe(false);
});

test("preserves a direct route while showing the anonymous shell", async ({
  page,
}) => {
  await page.goto("/planning");
  await expect(page).toHaveURL(/\/planning$/);
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Sign in with Google" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Development sign in" }),
  ).toHaveCount(0);
});

test("boots an authenticated lazy route and provides keyboard-safe dialogs", async ({
  page,
}) => {
  await page.route("http://127.0.0.1:4174/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/auth/session") {
      await route.fulfill({ json: session });
      return;
    }
    await route.fulfill({ json: [] });
  });

  await page.goto("/");
  await page.evaluate(() =>
    window.localStorage.setItem("checkbook.session", "e2e-token"),
  );
  await page.goto("/properties");
  await expect(page).toHaveURL(/\/assets$/);
  await expect(page.getByTitle("Profile")).toBeVisible();
  await expect(page.getByText("No properties yet")).toBeVisible();

  await page.getByTitle("Profile").click();
  await page.getByRole("button", { name: "Money map" }).click();
  await expect(page.getByRole("dialog", { name: "Money map" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Money map" })).toBeHidden();
});

export const emptyDashboard = {
  metrics: [],
  net_worth_trend: [],
  net_worth_components: [],
  cash_flow_trend: [],
  cash_flow_components: [],
  income_breakdown: [],
  expense_breakdown: [],
  expense_trend_by_category: [],
  utility_trend: [],
  savings_allocation: [],
  loans: [],
  upcoming_planned_expenses: [],
  recent_activity: [],
  goals: [],
  last_successful_import: null,
};

async function mockApi(page: import("@playwright/test").Page) {
  await page.route("http://127.0.0.1:4174/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/auth/session") {
      await route.fulfill({ json: session });
      return;
    }
    if (path === "/api/dashboard/overview") {
      await route.fulfill({ json: emptyDashboard });
      return;
    }
    if (path === "/api/household/expenses/board") {
      await route.fulfill({ json: { groups: [], categories: [], monthly_totals: [] } });
      return;
    }
    await route.fulfill({ json: [] });
  });
}

async function signInOnMobile(
  page: import("@playwright/test").Page,
  path = "/",
) {
  await mockApi(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(path);
  await page.evaluate(() =>
    window.localStorage.setItem("checkbook.session", "e2e-token"),
  );
  await page.reload();
  // On mobile the profile shell collapses into the bottom-nav household menu;
  // the topbar keeps the centered range label and the circular filter button.
  await expect(page.getByTitle("Date range")).toBeVisible();
}

test("topbar centered label follows the circular date-range filter", async ({
  page,
}) => {
  await mockApi(page);
  await page.addInitScript(() =>
    window.localStorage.setItem("checkbook.session", "e2e-token"),
  );
  await page.goto("/");

  // Without page-specific header info the centered label defaults to the
  // active filter range, and the range lives behind the circular filter
  // button on the right instead of a dropdown in the middle.
  const label = page.locator(".app-topbar-title");
  await expect(label).toHaveText("All time");

  const filterButton = page.getByTitle("Date range");
  const desktopWidth = page.viewportSize()?.width ?? 1280;
  const labelBox = await label.boundingBox();
  if (!labelBox) {
    throw new Error("topbar label is not visible");
  }
  expect(
    Math.abs(labelBox.x + labelBox.width / 2 - desktopWidth / 2),
  ).toBeLessThanOrEqual(2);

  await filterButton.click();
  const menu = page.getByRole("listbox", { name: "Date range" });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("option", { name: "All time" })).toHaveAttribute(
    "aria-selected",
    "true",
  );

  await menu.getByRole("option", { name: "12 months" }).click();
  await expect(menu).toBeHidden();
  await expect(label).toHaveText("12 months");
  await expect(filterButton).toBeFocused();

  // Narrow viewport: the label stays centered next to the collapsed actions.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(label).toBeVisible();
  const narrowBox = await label.boundingBox();
  if (!narrowBox) {
    throw new Error("topbar label is not visible on mobile");
  }
  expect(Math.abs(narrowBox.x + narrowBox.width / 2 - 390 / 2)).toBeLessThanOrEqual(
    2,
  );
});

test("mobile bottom nav exposes assets directly", async ({ page }) => {
  await signInOnMobile(page);

  // The household menu is gone: assets sits in the bottom nav itself,
  // in the slot the home-styled button used to occupy.
  for (const label of [
    "Overview",
    "Planning",
    "Income",
    "Expenses",
    "Assets",
    "User",
  ]) {
    await expect(
      page.locator(`.app-bottom-nav button[data-nav-label="${label}"]`),
    ).toBeVisible();
  }
  await expect(
    page.locator('.app-bottom-nav button[data-nav-label="Household"]'),
  ).toHaveCount(0);
  await expect(page.locator(".app-mobile-household-menu")).toHaveCount(0);

  const assetsButton = page.locator(
    '.app-bottom-nav button[data-nav-label="Assets"]',
  );
  await assetsButton.click();
  await expect(page).toHaveURL(/\/assets$/);
  await expect(assetsButton).toHaveClass(/is-active/);

  // The user sheet still opens alone above the nav.
  await page.locator('.app-bottom-nav button[data-nav-label="User"]').click();
  await expect(page.locator(".app-mobile-profile-menu")).toBeVisible();
});

test("mobile quick add picks the record kind from the title dropdown", async ({
  page,
}) => {
  await signInOnMobile(page);

  await page.locator(".overview-quick-add-fab").click();
  const dialog = page.locator(".record-add-modal");
  await expect(dialog).toBeVisible();

  // The tab strip is gone; the title carries the kind dropdown with its icons.
  await expect(dialog.locator(".quick-add-tabs")).toHaveCount(0);
  await expect(dialog.locator(".record-add-icon")).toBeVisible();
  await expect(
    dialog.getByRole("heading", { name: "Expense", exact: true }),
  ).toBeVisible();
  await expect(dialog.getByLabel("Name", { exact: true })).toBeVisible();

  // Field titles sit inside the boxes as placeholder help text, and every
  // field leads with an icon matching its type.
  await expect(dialog.getByLabel("Name", { exact: true })).toHaveAttribute(
    "placeholder",
    "Name",
  );
  await expect(dialog.locator(".outlined-field__icon").first()).toBeVisible();

  // The amount is formatted with grouping and its currency as it is typed.
  // (The amount input is located by placeholder: Playwright's label matching
  // uses raw label text, which includes the currency adornment.)
  const currencyBadge = dialog.locator(".record-add-field-currency");
  await expect(currencyBadge).toHaveClass(/is-empty/);
  const amountField = dialog.getByPlaceholder("Amount");
  await amountField.fill("1234.5");
  await expect(amountField).toHaveValue(/1[,. \u2009]234\.5/);
  await expect(currencyBadge).not.toHaveClass(/is-empty/);

  // Category sits left of Group in the same row, with no legacy subgroup
  // selector or synthetic General option.
  const pairFields = dialog.locator(".record-add-pair > .outlined-field");
  await expect(pairFields).toHaveCount(2);
  await expect(
    pairFields.nth(0).getByRole("combobox", { name: "Category", exact: true }),
  ).toBeVisible();
  await expect(
    pairFields.nth(1).getByRole("combobox", { name: "Group", exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("combobox", { name: "Subgroup", exact: true }),
  ).toHaveCount(0);
  await expect(
    dialog.getByRole("option", { name: "General", exact: true }),
  ).toHaveCount(0);
  // Read both positions in the same frame while the sheet animates into view.
  const [categoryBox, groupBox] = await pairFields.evaluateAll((fields) =>
    fields.map((field) => {
      const { x, y, width } = field.getBoundingClientRect();
      return { x, y, width };
    }),
  );
  if (!categoryBox || !groupBox) {
    throw new Error("Category and Group pair fields are not visible");
  }
  expect(categoryBox.y).toBe(groupBox.y);
  expect(categoryBox.x + categoryBox.width).toBeLessThanOrEqual(groupBox.x);
  expect(categoryBox.width).toBeGreaterThan(0);
  expect(groupBox.width).toBeGreaterThan(0);

  // Notes are opt-in: the field stays hidden until the "+ Add Notes" toggle
  // is used, and the toggle is additive — it disappears once revealed.
  await expect(dialog.getByLabel("Notes")).toHaveCount(0);
  const notesToggle = dialog.getByRole("button", { name: "Add Notes" });
  await expect(notesToggle).toHaveAttribute("aria-expanded", "false");
  await notesToggle.click();
  await expect(dialog.getByRole("button", { name: "Add Notes" })).toHaveCount(0);
  await expect(dialog.getByLabel("Notes")).toBeVisible();

  // The submit button keeps a constant height instead of stretching to
  // absorb the leftover full-screen modal space, and it is centered
  // horizontally on the page.
  const addButtonBox = await dialog
    .locator('.quick-add-actions button[type="submit"]')
    .boundingBox();
  const viewportWidth = page.viewportSize()?.width ?? 390;
  if (!addButtonBox) {
    throw new Error("Add record button is not visible");
  }
  expect(addButtonBox.height).toBeGreaterThanOrEqual(36);
  expect(addButtonBox.height).toBeLessThanOrEqual(64);
  expect(addButtonBox.y + addButtonBox.height).toBeLessThanOrEqual(844);
  expect(
    Math.abs(
      addButtonBox.x + addButtonBox.width / 2 - viewportWidth / 2,
    ),
  ).toBeLessThanOrEqual(2);

  const kindToggle = dialog.locator(".record-add-kind-toggle");
  await kindToggle.click();
  const kindMenu = dialog.locator(".record-add-kind-menu");
  await expect(kindMenu).toBeVisible();
  await expect(kindMenu.getByRole("option")).toHaveText(["Expense", "Recurring expense", "Loan"]);

  await kindMenu.getByRole("option", { name: "Loan" }).click();
  await expect(kindMenu).toBeHidden();
  await expect(
    dialog.getByRole("heading", { name: "Loan", exact: true }),
  ).toBeVisible();
  await expect(dialog.getByLabel("Current balance")).toBeVisible();
  await expect(dialog.getByPlaceholder("Amount", { exact: true })).toHaveCount(
    0,
  );

  // The loan tab shares the icon-led field style, with currency badges on the
  // money fields and a percent badge on the interest rate.
  await expect(dialog.locator(".outlined-field__icon").first()).toBeVisible();
  await expect(
    dialog.getByPlaceholder("Current balance"),
  ).toBeVisible();
  const loanCurrencyBadges = dialog.locator(".record-add-field-currency");
  await expect(loanCurrencyBadges).toHaveCount(4);
  await expect(loanCurrencyBadges.nth(3)).toHaveText("%");
  await dialog.getByPlaceholder("Current balance").fill("250000");
  await expect(dialog.getByPlaceholder("Current balance")).toHaveValue(
    /250[,. \u2009]000/,
  );

  // Loan notes stay hidden behind the same opt-in toggle.
  await expect(dialog.getByLabel("Notes")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Add Notes" }).click();
  await expect(dialog.getByLabel("Notes")).toBeVisible();

  // The header icon follows the selected kind.
  await kindToggle.click();
  await kindMenu.getByRole("option", { name: "Expense", exact: true }).click();
  await expect(
    dialog.getByRole("heading", { name: "Expense", exact: true }),
  ).toBeVisible();
  await expect(dialog.getByLabel("Name", { exact: true })).toBeVisible();
});

test("mobile category modal rises from the bottom as a content-sized sheet", async ({
  page,
}) => {
  await page.route("http://127.0.0.1:4174/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/auth/session") {
      await route.fulfill({ json: session });
      return;
    }
    if (path === "/api/household/settings") {
      await route.fulfill({ json: session.settings });
      return;
    }
    if (path === "/api/dashboard/overview") {
      await route.fulfill({ json: emptyDashboard });
      return;
    }
    if (path === "/api/household/expenses/board") {
      await route.fulfill({ json: { groups: [], categories: [], monthly_totals: [] } });
      return;
    }
    await route.fulfill({ json: [] });
  });
  await page.addInitScript(() =>
    window.localStorage.setItem("checkbook.session", "e2e-token"),
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/expenses");
  await page.locator(".quick-add-fab").click();
  await page.locator(".record-add-kind-toggle").click();
  await page.getByRole("option", { name: "Category", exact: true }).click();
  await expect(page.locator(".record-add-modal")).toHaveCount(0);
  const dialog = page.locator(".expense-group-modal");
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("heading", { name: "New category" }),
  ).toBeVisible();

  // Notes stay hidden until the "+ Add Notes" button reveals the field, and
  // the toggle disappears once it has been used.
  await expect(dialog.getByLabel("Notes")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Add Notes" }).click();
  await expect(dialog.getByLabel("Notes")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Add Notes" })).toHaveCount(
    0,
  );

  // The sheet's entrance slide must settle before measuring geometry.
  await expect
    .poll(() => dialog.evaluate((node) => getComputedStyle(node).transform))
    .toBe("none");

  const sheet = await page.evaluate(() => {
    const node = document.querySelector(".expense-group-modal")!;
    const backdrop = document.querySelector(".modal-backdrop")!;
    const header = node.querySelector(".drive-picker__header")!;
    const title = node.querySelector(".drive-picker__header-title")!;
    const bar = node.querySelector(".quick-add-actions")!;
    const submit = bar.querySelector("button")!;
    const checked = node.querySelector('[role="radio"][aria-checked="true"]')!;
    const box = node.getBoundingClientRect();
    const submitBox = submit.getBoundingClientRect();
    const radii = getComputedStyle(node).borderRadius
      .split(" ")
      .map((value) => Number.parseFloat(value));
    return {
      left: box.left,
      right: box.right,
      top: box.top,
      bottom: box.bottom,
      height: box.height,
      headerLeft: header.getBoundingClientRect().left,
      headerTop: header.getBoundingClientRect().top,
      titleLeft: title.getBoundingClientRect().left,
      barBottom: bar.getBoundingClientRect().bottom,
      submitCenter: (submitBox.left + submitBox.right) / 2,
      submitWidth: submitBox.width,
      backdropAlign: getComputedStyle(backdrop).alignItems,
      backdropBlur: getComputedStyle(backdrop).backdropFilter,
      backdropBackground: getComputedStyle(backdrop).backgroundColor,
      checkedShadow: getComputedStyle(checked).boxShadow,
      checkedSize: checked.getBoundingClientRect().width,
      radii,
    };
  });

  // Seated on the bottom of the screen, full width, rounded top corners only,
  // and only as tall as its content rather than filling the viewport.
  expect(sheet.left).toBe(0);
  expect(sheet.right).toBe(390);
  expect(sheet.bottom).toBe(844);
  expect(sheet.height).toBeGreaterThan(250);
  expect(sheet.height).toBeLessThan(700);
  expect(sheet.radii).toEqual([14.4, 14.4, 0, 0]);
  // The page stays unobscured, with no grey dim or compositor-dependent blur.
  expect(sheet.backdropAlign).toBe("flex-end");
  expect(sheet.backdropBlur).toBe("none");
  expect(sheet.backdropBackground).toBe("rgba(0, 0, 0, 0)");
  // Header titles keep their distance from the screen edge and lead the
  // sheet from its very top edge.
  expect(sheet.titleLeft).toBeGreaterThanOrEqual(16);
  expect(sheet.headerTop).toBe(sheet.top);
  // The save button stays compact but centered, and the bar hugs the sheet
  // bottom.
  expect(sheet.submitCenter).toBeCloseTo(195, 0);
  expect(sheet.submitWidth).toBeGreaterThanOrEqual(80);
  expect(sheet.submitWidth).toBeLessThanOrEqual(190);
  expect(844 - sheet.barBottom).toBeLessThanOrEqual(1);
  // The selected color swatch is unmistakable: thumb-sized with an accent
  // ring around it.
  expect(sheet.checkedSize).toBeCloseTo(36, 0);
  expect(sheet.checkedShadow).toContain("rgb(30, 111, 214)");
  await expect(dialog.locator(".record-add-close")).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollHeight),
  ).toBe(844);
  await page.screenshot({ path: "test-results/category-sheet-mobile.png" });

  // Desktop keeps the centered floating-card presentation.
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(dialog).toBeVisible();
  await page.screenshot({ path: "test-results/category-modal-desktop.png" });
});

test("every add window keeps the rendered app visible through a clear backdrop", async ({
  page,
  isMobile,
}, testInfo) => {
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("response", (response) => {
    if (response.status() >= 400) browserErrors.push(`${response.status()} ${response.url()}`);
  });
  page.on("requestfailed", (request) => {
    browserErrors.push(`${request.failure()?.errorText} ${request.url()}`);
  });
  await page.route("http://127.0.0.1:4174/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/auth/session") {
      await route.fulfill({ json: session });
      return;
    }
    if (path === "/api/household/settings") {
      await route.fulfill({ json: session.settings });
      return;
    }
    if (path === "/api/dashboard/overview") {
      await route.fulfill({ json: emptyDashboard });
      return;
    }
    if (path === "/api/household/expenses/board") {
      await route.fulfill({ json: { groups: [], categories: [], monthly_totals: [] } });
      return;
    }
    await route.fulfill({ json: [] });
  });
  await page.addInitScript(() =>
    window.localStorage.setItem("checkbook.session", "e2e-token"),
  );
  const assertSheet = async (
    open: () => Promise<void>,
    width: number,
    height: number,
    screenshot: string,
  ) => {
    const app = page.locator(".app-shell");
    await expect(app).toBeVisible();
    await expect(page.locator(".app-content")).not.toContainText("Loading workspace...");
    if (new URL(page.url()).pathname === "/expenses") {
      await expect(page.getByRole("button", { name: "Manage recurring expenses" })).toBeVisible();
    }
    const appContent = await page.locator(".app-content").innerText();
    expect(appContent.trim().length).toBeGreaterThan(0);
    // A high-contrast marker inside the app proves painted visibility, not just
    // DOM presence or a transparent computed background on an opaque compositor.
    await page.locator(".app-content").evaluate((node) => {
      node.style.position = "relative";
      const marker = document.createElement("div");
      marker.dataset.backdropProbe = "true";
      marker.style.cssText = `position:absolute;top:${node.scrollTop + 32}px;left:16px;width:100px;height:24px;background:repeating-linear-gradient(90deg,#132f58 0 10px,#edab35 10px 20px);pointer-events:none`;
      node.append(marker);
    });
    const probe = page.locator("[data-backdrop-probe]");
    // Wait for stable geometry and finish shell transitions before recording the
    // clip. A pre-screenshot bounding box can race the collapsing mobile chrome.
    const before = await probe.screenshot({ animations: "disabled", scale: "css" });
    const probeClip = await probe.boundingBox();
    expect(probeClip).not.toBeNull();
    if (!probeClip) throw new Error("Missing rendered backdrop probe");
    const scrollTop = await page.locator(".app-content").evaluate((node) => node.scrollTop);
    await open();
    const sheet = page.locator(".modal-sheet");
    await expect(sheet).toBeVisible();
    await expect
      .poll(() => sheet.evaluate((node) => getComputedStyle(node).transform))
      .toBe("none");
    const info = await sheet.evaluate((node) => {
      const box = node.getBoundingClientRect();
      const backdrop = node.parentElement!;
      const backdropStyle = getComputedStyle(backdrop);
      const radii = getComputedStyle(node).borderRadius
        .split(" ")
        .map((value) => Number.parseFloat(value));
      return {
        left: box.left,
        right: box.right,
        top: box.top,
        bottom: box.bottom,
        height: box.height,
        radii,
        align: backdropStyle.alignItems,
        blur: backdropStyle.backdropFilter,
        webkitBlur: backdropStyle.getPropertyValue("-webkit-backdrop-filter"),
        background: backdropStyle.backgroundColor,
      };
    });
    if (width < 768) {
      expect(info.left).toBe(0);
      expect(info.right).toBe(width);
      expect(info.bottom).toBe(height);
      expect(info.height).toBeLessThan(height);
      expect(info.radii).toEqual([14.4, 14.4, 0, 0]);
      expect(info.align).toBe("flex-end");
    } else {
      expect(info.left).toBeGreaterThan(0);
      expect(info.right).toBeLessThan(width);
      expect((info.left + info.right) / 2).toBeCloseTo(width / 2, 0);
      expect((info.top + info.bottom) / 2).toBeCloseTo(height / 2, 0);
      expect(info.align).toBe("center");
    }
    expect(info.blur).toBe("none");
    if (await page.evaluate(() => CSS.supports("-webkit-backdrop-filter", "blur(6px)"))) {
      expect(info.webkitBlur).toBe("none");
    }
    expect(info.background).toBe("rgba(0, 0, 0, 0)");
    // Keep the overlay outside the workspace's scrolling/clipping layer.
    expect(
      await sheet.evaluate((node) => node.parentElement?.parentElement?.nodeName),
    ).toBe("BODY");
    await expect(app).toBeVisible();
    await expect.poll(() => page.locator(".app-content").innerText()).toBe(appContent);
    await expect(app).toHaveCSS("opacity", "1");
    await expect(app).toHaveCSS("filter", "none");
    expect(await probe.boundingBox()).toEqual(probeClip);
    expect(await page.screenshot({ clip: probeClip, animations: "disabled", scale: "css" })).toEqual(before);
    await expect(page.locator(".app-content")).toHaveCSS("overflow-y", "hidden");
    expect(await page.evaluate(() => document.body.style.position)).not.toBe("fixed");
    expect(await page.locator(".app-content").evaluate((node) => node.scrollTop)).toBe(scrollTop);
    await page.locator("[data-backdrop-probe]").evaluate((node) => node.remove());
    await page.screenshot({ path: testInfo.outputPath(`${screenshot}.png`) });
    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);
    await expect(page.locator(".app-content")).toHaveCSS("overflow-y", "auto");
    expect(await page.locator(".app-content").evaluate((node) => node.scrollTop)).toBe(scrollTop);
  };

  for (const { width, height, device } of [
    { width: 1280, height: 900, device: "desktop" },
    { width: 390, height: 844, device: "mobile" },
  ]) {
    if (isMobile && width >= 768) continue;
    await page.setViewportSize({ width, height });
    await page.goto("/expenses");
    await assertSheet(
      async () => {
        await expect(page.getByRole("button", { name: "New category", exact: true })).toHaveCount(0);
        await page.locator(".quick-add-fab").click();
        const quickAdd = page.locator(".record-add-modal");
        await quickAdd.locator(".record-add-kind-toggle").click();
        const kindMenu = quickAdd.locator(".record-add-kind-menu");
        await expect(kindMenu.getByRole("option")).toHaveText(["Expense", "Recurring expense", "Loan", "Category"]);
        await expect
          .poll(() => quickAdd.evaluate((node) => getComputedStyle(node).transform))
          .toBe("none");
        await page.screenshot({ path: testInfo.outputPath(`expense-kind-menu-${device}.png`) });
        await kindMenu.getByRole("option", { name: "Category", exact: true }).click();
        await expect(quickAdd).toHaveCount(0);
        await expect(page.getByRole("dialog")).toHaveCount(1);
        await expect(page.getByRole("heading", { name: "New category", exact: true })).toBeVisible();
      },
      width, height, `category-sheet-${device}`,
    );
    await assertSheet(
      () => page.locator(".quick-add-fab").click(),
      width, height, `quick-add-sheet-${device}`,
    );
    await page.goto("/properties");
    await assertSheet(
      () => page.getByRole("button", { name: "Add asset, utility, or project" }).click(),
      width, height, `property-sheet-${device}`,
    );
    // Exercise the independent scroll layer with mobile chrome collapsed too.
    await page.locator(".app-content").evaluate((node) => {
      const spacer = document.createElement("div");
      spacer.style.height = "1600px";
      spacer.dataset.scrollProbe = "true";
      node.append(spacer);
      node.scrollTop = 240;
    });
    await expect.poll(() => page.locator(".app-content").evaluate((node) => node.scrollTop)).toBe(240);
    if (width < 768) await expect(page.locator(".app-shell")).toHaveClass(/mobile-chrome-hidden/);
    await assertSheet(
      () => page.locator(".quick-add-fab").click(),
      width, height, `scrolled-sheet-${device}`,
    );
    await page.locator("[data-scroll-probe]").evaluate((node) => node.remove());
  }
  expect(browserErrors).toEqual([]);
});

test("category kebab menu edits the category or adds a group to it", async ({
  page,
}) => {
  const group = {
    id: "grp-living",
    name: "Living",
    color: "16 148 111",
    notes: "",
    sort_order: 0,
  };
  const longGroup = {
    ...group,
    id: "grp-long",
    name: "Home maintenance and everyday living",
  };
  const groceries = {
    id: "cat-groceries",
    name: "Groceries",
    expense_group_id: "grp-living",
    is_system: false,
    sort_order: 0,
    total_amount: 400,
    monthly_average: 200,
    entry_count: 2,
    first_entry_date: null,
    last_entry_date: "2026-09-30",
  };
  await page.route("http://127.0.0.1:4174/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/auth/session") {
      await route.fulfill({ json: session });
      return;
    }
    if (path === "/api/household/settings") {
      await route.fulfill({ json: session.settings });
      return;
    }
    if (path === "/api/dashboard/overview") {
      await route.fulfill({ json: emptyDashboard });
      return;
    }
    if (path === "/api/household/expenses/board") {
      await route.fulfill({
        json: { groups: [group, longGroup], categories: [groceries], monthly_totals: [] },
      });
      return;
    }
    await route.fulfill({ json: [] });
  });
  await page.addInitScript(() =>
    window.localStorage.setItem("checkbook.session", "e2e-token"),
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/expenses");

  // A long category title ellipsizes onto one line and the kebab stays on
  // that same row, flush right.
  const longKebabLabel =
    "Category options for Home maintenance and everyday living";
  const row = await page
    .locator(".expense-group-name")
    .filter({ hasText: "Home maintenance" })
    .evaluate((nameNode, kebabLabel) => {
      const kebab = document.querySelector<HTMLButtonElement>(
        `[aria-label="${kebabLabel}"]`,
      )!;
      const panel = kebab.closest(".panel")!;
      const nameBox = nameNode.getBoundingClientRect();
      const kebabBox = kebab.getBoundingClientRect();
      return {
        nameHeight: nameBox.height,
        rowOffset: Math.abs(
          nameBox.top + nameBox.bottom - kebabBox.top - kebabBox.bottom,
        ) / 2,
        rightGap: panel.getBoundingClientRect().right - kebabBox.right,
      };
    }, longKebabLabel);
  expect(row.nameHeight).toBeLessThan(32);
  expect(row.rowOffset).toBeLessThanOrEqual(4);
  expect(row.rightGap).toBeGreaterThanOrEqual(0);
  expect(row.rightGap).toBeLessThanOrEqual(32);

  // The pencil is gone; the kebab holds both actions.
  await expect(page.locator(".group-edit-button")).toHaveCount(0);
  const kebab = page.getByRole("button", { name: "Category options for Living" });
  await kebab.click();
  await page.screenshot({ path: "test-results/category-kebab-mobile.png" });
  await page.getByRole("menuitem", { name: "Edit category" }).click();
  const editDialog = page.getByRole("dialog", { name: "Edit category" });
  await expect(editDialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(editDialog).toHaveCount(0);

  // "Add group" files a new group under the category, as a shared sheet.
  await kebab.click();
  const created = page.waitForRequest(
    (request) =>
      request.method() === "POST" &&
      request.url().includes("/household/expense-categories"),
  );
  await page.getByRole("menuitem", { name: "Add group" }).click();
  const dialog = page.getByRole("dialog", { name: "Add group" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveClass(/modal-sheet/);
  await dialog.getByLabel("Name", { exact: true }).fill("Rent");
  await dialog.getByRole("button", { name: "Add group" }).click();
  const request = await created;
  expect(JSON.parse(request.postData()!)).toEqual({
    name: "Rent",
    expense_group_id: "grp-living",
    sort_order: 1,
  });
  await expect(dialog).toHaveCount(0);

  // Desktop keeps the same kebab affordance in the section header.
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.reload();
  await expect(kebab).toBeVisible();
  await kebab.click();
  await page.screenshot({ path: "test-results/category-kebab-desktop.png" });
});

test("grouped expense detail header fits narrow screens", async ({ page }) => {
  // Long group and expense names: the title used to blow the modal header
  // past the right screen edge once a group pill joined the name.
  const board = {
    monthly_totals: [],
    groups: [
      {
        id: "group-1",
        name: "Everyday Living and Household Necessities",
        color: "30 111 214",
        notes: "",
        sort_order: 0,
      },
    ],
    categories: [
      {
        id: "cat-1",
        name: "Groceries and everyday supermarket shopping",
        parent_id: null,
        expense_group_id: "group-1",
        is_system: false,
        sort_order: 0,
        total_amount: 1200,
        monthly_average: 300,
        entry_count: 1,
        first_entry_date: "2026-01-05",
        last_entry_date: "2026-01-05",
      },
    ],
  };
  const detail = {
    id: "cat-1",
    name: "Groceries and everyday supermarket shopping",
    expense_group_id: "group-1",
    is_system: false,
    sort_order: 0,
    subcategories: [],
    monthly_totals: [{ period: "2026-01", value: 300 }],
    entries: [
      {
        id: "e-1",
        description: "Groceries",
        amount: 100,
        entry_date: "2026-01-05",
        owner_scope: "joint",
        notes: "",
        data_source: "manual",
      },
    ],
  };
  await page.route("http://127.0.0.1:4174/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/auth/session") {
      await route.fulfill({ json: session });
      return;
    }
    if (path === "/api/household/settings") {
      await route.fulfill({ json: session.settings });
      return;
    }
    if (path === "/api/dashboard/overview") {
      await route.fulfill({ json: emptyDashboard });
      return;
    }
    if (path === "/api/household/expenses/board") {
      await route.fulfill({ json: board });
      return;
    }
    if (path === "/api/household/expense-categories/cat-1") {
      await route.fulfill({ json: detail });
      return;
    }
    await route.fulfill({ json: [] });
  });
  await page.addInitScript(() =>
    window.localStorage.setItem("checkbook.session", "e2e-token"),
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/expenses");
  await page.getByRole("button", { name: /Groceries/ }).click();
  const modal = page.locator(".record-detail-modal");
  await expect(modal).toBeVisible();
  // The header shows just the name — no category pill.
  await expect(modal.locator(".expense-group-pill")).toHaveCount(0);

  // The header stays inside the dialog, the name ellipsizes instead of
  // wrapping, and nothing overflows the document.
  const header = await modal.evaluate((root) => {
    const head = root.querySelector(".drive-picker__header")!;
    const name = root.querySelector(".expense-detail-name")!;
    return {
      headLeft: head.getBoundingClientRect().left,
      headRight: head.getBoundingClientRect().right,
      nameClipped:
        name.scrollWidth > name.clientWidth + 1 &&
        getComputedStyle(name).textOverflow === "ellipsis",
      viewport: window.innerWidth,
    };
  });
  expect(header.headLeft).toBe(0);
  expect(header.headRight).toBe(header.viewport);
  expect(header.nameClipped).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    390,
  );

  // The "This month" delta stays on the amount's line: the tile is one line
  // tall and the qualifier is dropped entirely on phones.
  await expect(modal.locator(".vs-avg-label")).toBeHidden();
  const thisMonthTile = modal
    .locator(".expense-detail-stats div")
    .filter({ hasText: "This month" });
  expect(
    await thisMonthTile.locator("strong").evaluate(
      (node) => node.getBoundingClientRect().height,
    ),
  ).toBeLessThan(28);

  // Desktop keeps the qualifier.
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(modal.locator(".vs-avg-label")).toBeVisible();
  await expect(modal.locator(".vs-avg-label")).toHaveText("vs avg");
});

test("expense mix details keep one row per group on narrow screens", async ({
  page,
}) => {
  const groupedDashboard = {
    ...dashboardOverview,
    expense_breakdown: [
      { label: "Fixed", value: 300, share: 0.25 },
      { label: "Fun stuff", value: 100, share: 0.08 },
      { label: "Groceries", value: 500, share: 0.42 },
    ],
    savings_allocation: [
      { label: "Emergency fund", value: 5000, share: 0.5 },
      { label: "House fund", value: 3000, share: 0.3 },
      { label: "Car fund", value: 2000, share: 0.2 },
    ],
  };
  await page.route("http://127.0.0.1:4174/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/auth/session") {
      await route.fulfill({ json: session });
      return;
    }
    if (path === "/api/household/settings") {
      await route.fulfill({ json: session.settings });
      return;
    }
    if (path === "/api/dashboard/overview") {
      await route.fulfill({ json: groupedDashboard });
      return;
    }
    if (path === "/api/household/expenses/board") {
      await route.fulfill({
        json: {
          groups: [
            { id: "group-1", name: "Fixed", color: "#123456", notes: null },
            { id: "group-2", name: "Fun stuff", color: "#654321", notes: null },
          ],
          entries: [],
        },
      });
      return;
    }
    await route.fulfill({ json: [] });
  });
  await page.addInitScript(() =>
    window.localStorage.setItem("checkbook.session", "e2e-token"),
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");

  await page
    .locator(".panel", { hasText: "Expense mix" })
    .getByRole("button", { name: "Details" })
    .click();
  const modal = page.locator(".overview-detail-modal");
  await expect(modal).toBeVisible();
  await expect(modal.getByRole("heading", { name: "Expense mix details" })).toBeVisible();

  const rows = modal.locator(".detail-row--button");
  await expect(rows).toHaveCount(3);
  await expect(rows.first()).toContainText("Uncategorized");

  // Each group stays on a single line: label, value, and share share one
  // baseline, and the value/share columns line up down the whole list.
  const layout = await modal.evaluate((root) => {
    const rows = Array.from(root.querySelectorAll(".detail-row--button"));
    const centers = rows.map((row) => {
      const items = Array.from(row.children).map((child) => {
        const box = child.getBoundingClientRect();
        return box.top + box.height / 2;
      });
      return {
        oneLine: Math.max(...items) - Math.min(...items) <= 1.5,
        valueRight: (row.children[1] as HTMLElement).getBoundingClientRect().right,
        shareRight: (row.children[2] as HTMLElement).getBoundingClientRect().right,
      };
    });
    const spread = (values: number[]) => Math.max(...values) - Math.min(...values);
    return {
      oneLine: centers.every((row) => row.oneLine),
      valueSpread: spread(centers.map((row) => row.valueRight)),
      shareSpread: spread(centers.map((row) => row.shareRight)),
    };
  });
  expect(layout.oneLine).toBe(true);
  expect(layout.valueSpread).toBeLessThanOrEqual(1);
  expect(layout.shareSpread).toBeLessThanOrEqual(1);

  // Rows pack at the top of the page-sized modal at their natural height —
  // the stretch grid must not spread three groups across the whole screen.
  const packed = await modal.evaluate((root) => {
    const rows = Array.from(root.querySelectorAll(".detail-row--button"));
    const boxes = rows.map((row) => row.getBoundingClientRect());
    return {
      trailingFill: (root.querySelector(".detail-table")?.getBoundingClientRect().bottom ?? 0) - boxes[boxes.length - 1].bottom,
      tallestRow: Math.max(...boxes.map((box) => box.height)),
      worstGap: boxes
        .slice(1)
        .map((box, index) => box.top - boxes[index].bottom),
    };
  });
  expect(packed.trailingFill).toBeLessThanOrEqual(2);
  expect(packed.tallestRow).toBeLessThan(80);
  expect(Math.max(...packed.worstGap)).toBeLessThanOrEqual(3);

  // Savings allocation details: same one-line rows with normal spacing.
  await page.keyboard.press("Escape");
  await page
    .locator(".panel", { hasText: "Savings allocation" })
    .getByRole("button", { name: "Details" })
    .click();
  await expect(modal).toBeVisible();
  await expect(modal.getByRole("heading", { name: "Savings allocation details" })).toBeVisible();

  const savingsRows = modal.locator(".detail-row");
  await expect(savingsRows).toHaveCount(3);
  const savingsLayout = await modal.evaluate((root) => {
    const rows = Array.from(root.querySelectorAll(".detail-row"));
    const boxes = rows.map((row) => row.getBoundingClientRect());
    const oneLine = rows.every((row) => {
      const items = Array.from(row.children).map((child) => {
        const box = child.getBoundingClientRect();
        return box.top + box.height / 2;
      });
      return Math.max(...items) - Math.min(...items) <= 1.5;
    });
    return {
      oneLine,
      trailingFill: (root.querySelector(".detail-table")?.getBoundingClientRect().bottom ?? 0) - boxes[boxes.length - 1].bottom,
      tallestRow: Math.max(...boxes.map((box) => box.height)),
      worstGap: boxes.slice(1).map((box, index) => box.top - boxes[index].bottom),
    };
  });
  expect(savingsLayout.trailingFill).toBeLessThanOrEqual(2);
  expect(savingsLayout.oneLine).toBe(true);
  expect(savingsLayout.tallestRow).toBeLessThan(80);
  expect(Math.max(...savingsLayout.worstGap)).toBeLessThanOrEqual(3);
});
