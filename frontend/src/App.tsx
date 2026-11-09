import { OutlinedInput } from './components/ui/OutlinedField'
import {
	lazy,
	Suspense,
	useEffect,
	useRef,
	useState,
	type CSSProperties,
} from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
	Archive,
	Banknote,
	Building2,
	ChevronDown,
	CircleUserRound,
	Database,
	LayoutDashboard,
	Mail,
	Map,
	Menu,
	PanelLeftClose,
	ReceiptText,
	SlidersHorizontal,
	Sparkles,
	Waypoints,
	X,
} from "lucide-react";
import "./App.css";
import "./styles/features/gantt.css";
import "./styles/features/projects.css";
import "./styles/features/income.css";
import "./styles/features/expense-detail.css";
import "./styles/features/income-ledger.css";
import "./styles/features/money-map.css";
import "./styles/features/backups.css";
import "./styles/features/property-links.css";
import "./styles/features/invoices.css";
import "./styles/features/expenses.css";
import "./styles/features/utilities.css";
import "./styles/features/overview.css";
import { AuthWaveBackground } from "./components/AuthWaveBackground";
import { BackupsModal } from "./components/BackupsModal";
import { MoneyMapModal } from "./components/MoneyMapModal";
import { DateRangeFilter } from "./components/DateRangeFilter";
import { api } from "./lib/api";
import { queryClient } from "./app/query-client";
import { TAB_PATHS, tabFromPath, isLegacyAssetsPath, isPaydayPlannerAnalysisPath } from "./app/routes";
import type { TabKey } from "./app/routes";
import { dateRangeOptionLabel, rangeLabel } from "./lib/format";
import type { DateRangeKey } from "./lib/format";
import { useBottomNavPreview } from "./lib/use-bottom-nav-preview";
import { useAutoBackups } from "./features/backups/autoBackup";
import { HeaderSlotProvider, useHeaderSlotContext } from "./lib/header-slot";
import { SessionProvider, STORAGE_KEY, useSession } from "./lib/session";

const DEV_AUTH_ENABLED = import.meta.env.VITE_ENABLE_DEV_AUTH === "true";

const OverviewPage = lazy(() =>
	import("./pages/OverviewPage").then((module) => ({
		default: module.OverviewPage,
	})),
);
const IncomePage = lazy(() =>
	import("./pages/IncomePage").then((module) => ({
		default: module.IncomePage,
	})),
);
const PaydayPlannerPage = lazy(() =>
	import("./pages/PaydayPlannerPage").then((module) => ({ default: module.PaydayPlannerPage })),
);
const PaydayPlannerAnalysisPage = lazy(() =>
	import("./pages/PaydayPlannerAnalysisPage").then((module) => ({ default: module.PaydayPlannerAnalysisPage })),
);
const ExpensesPage = lazy(() =>
	import("./pages/ExpensesPage").then((module) => ({
		default: module.ExpensesPage,
	})),
);
const AssetsPage = lazy(() =>
	import("./pages/AssetsPage").then((module) => ({
		default: module.AssetsPage,
	})),
);
const ImportsPage = lazy(() =>
	import("./pages/ImportsPage").then((module) => ({
		default: module.ImportsPage,
	})),
);
const SettingsPage = lazy(() =>
	import("./pages/SettingsPage").then((module) => ({
		default: module.SettingsPage,
	})),
);

const NAV_ITEMS: Array<{
	key: TabKey;
	label: string;
	icon: typeof LayoutDashboard;
}> = [
	{ key: "overview", label: "Overview", icon: LayoutDashboard },
	{ key: "planning", label: "Planning", icon: Waypoints },
	{ key: "income", label: "Income", icon: Banknote },
	{ key: "expenses", label: "Expenses", icon: ReceiptText },
	{ key: "assets", label: "Assets", icon: Building2 },
	{ key: "imports", label: "Imports", icon: Database },
	{ key: "settings", label: "Settings", icon: SlidersHorizontal },
];


function GoogleGlyph() {
	return (
		<svg className="auth-google__glyph" viewBox="0 0 18 18" aria-hidden="true">
			<path
				fill="#4285F4"
				d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.91c1.7-1.57 2.69-3.88 2.69-6.62Z"
			/>
			<path
				fill="#34A853"
				d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.91-2.26c-.81.54-1.84.86-3.05.86-2.35 0-4.33-1.58-5.04-3.71H.96v2.33A9 9 0 0 0 9 18Z"
			/>
			<path
				fill="#FBBC05"
				d="M3.96 10.71A5.41 5.41 0 0 1 3.68 9c0-.6.1-1.18.28-1.71V4.96H.96A9 9 0 0 0 0 9c0 1.45.35 2.83.96 4.04l3-2.33Z"
			/>
			<path
				fill="#EA4335"
				d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.59C13.46.89 11.43 0 9 0A9 9 0 0 0 .96 4.96l3 2.33C4.67 5.16 6.65 3.58 9 3.58Z"
			/>
		</svg>
	);
}

function ToastBanner({
	type,
	children,
	onClose,
}: {
	type: "error" | "success";
	children: string;
	onClose: () => void;
}) {
	return (
		<div
			className={`toast-banner toast-banner--${type}`}
			role={type === "error" ? "alert" : "status"}
		>
			<span>{children}</span>
			<button
				aria-label={`Dismiss ${type} message`}
				onClick={onClose}
				type="button"
			>
				<X className="h-4 w-4" />
			</button>
		</div>
	);
}

function DevelopmentLogin() {
	const { applySession, setError, setMessage } = useSession();
	const [authForm, setAuthForm] = useState({ email: "", fullName: "" });
	const [showEmail, setShowEmail] = useState(false);
	const [busy, setBusy] = useState(false);

	async function signIn() {
		setBusy(true);
		setError(null);
		try {
			applySession(await api.devLogin(authForm.email, authForm.fullName));
			setMessage(null);
		} catch (nextError) {
			setError(nextError instanceof Error ? nextError.message : "Sign in failed.");
		} finally {
			setBusy(false);
		}
	}

	return (
		<>
			<button
				aria-expanded={showEmail}
				className="button button--ghost auth-email-toggle"
				onClick={() => setShowEmail((value) => !value)}
				type="button"
			>
				<Mail className="h-4 w-4" />
				Development sign in
			</button>
			<div className={`auth-email ${showEmail ? "is-open" : ""}`}>
				<div className="auth-email__inner">
					<form
						className="auth-email-form"
						onSubmit={(event) => {
							event.preventDefault();
							void signIn();
						}}
					>
						<OutlinedInput id="auth-email" label="Email"
								type="email"
								value={authForm.email}
								onChange={(event) =>
									setAuthForm({ ...authForm, email: event.target.value })
								}
							/>
						<OutlinedInput id="auth-name" label="Name"
								value={authForm.fullName}
								onChange={(event) =>
									setAuthForm({ ...authForm, fullName: event.target.value })
								}
							/>
						<button className="button" disabled={busy} type="submit">
							{busy ? "Signing in..." : "Continue with email"}
						</button>
					</form>
				</div>
			</div>
		</>
	);
}

function AppContent() {
	const {
		session,
		token,
		applySession,
		clearSession,
		error,
		message,
		setError,
		setMessage,
	} = useSession();
	const [busy, setBusy] = useState<string | null>(null);
	const location = useLocation();
	const navigate = useNavigate();
	const { headerControls, headerActions } = useHeaderSlotContext();
	const tab = tabFromPath(location.pathname);
	const propertyFilter = new URLSearchParams(location.search).get("property");
	// The Properties page was renamed to Assets: legacy /properties links
	// (including their ?property= deep-link id) redirect to /assets.
	useEffect(() => {
		if (isLegacyAssetsPath(location.pathname)) {
			navigate(`${TAB_PATHS.assets}${location.search}`, { replace: true });
		}
	}, [location.pathname, location.search, navigate]);
	const [dateRange, setDateRange] = useState<DateRangeKey>("all");
	const [expensesDateRange, setExpensesDateRange] =
		useState<DateRangeKey>("all");
	const [showForecast, setShowForecast] = useState(false);
	const [showExpensesForecast, setShowExpensesForecast] = useState(false);
	const [showRetiredExpenses, setShowRetiredExpenses] = useState(false);
	const activeForecast = tab === "expenses" ? showExpensesForecast : showForecast;
	const activeRange =
		tab === "expenses" ? expensesDateRange : dateRange;
	const [booting, setBooting] = useState(true);
	const [isSidebarOpen, setIsSidebarOpen] = useState(false);
	const [isProfileMenuOpen, setIsProfileMenuOpen] = useState(false);
	const [isUserSheetOpen, setIsUserSheetOpen] = useState(false);
	const [isMobileChromeHidden, setIsMobileChromeHidden] = useState(false);
	const [isMoneyMapOpen, setIsMoneyMapOpen] = useState(false);
	const [isBackupsOpen, setIsBackupsOpen] = useState(false);
	const profileMenuRef = useRef<HTMLDivElement | null>(null);
	const appContentRef = useRef<HTMLDivElement | null>(null);
	const mobileChromeHiddenRef = useRef(false);
	const bottomNavRef = useRef<HTMLElement | null>(null);
	const navPreview = useBottomNavPreview(bottomNavRef);
	// Daily NAS backups trigger from the client while the app is open.
	useAutoBackups(token);

	const navigateToTab = (nextTab: TabKey, propertyId?: string | null) => {
		const search = propertyId
			? `?property=${encodeURIComponent(propertyId)}`
			: "";
		navigate(`${TAB_PATHS[nextTab]}${search}`);
	};

	useEffect(() => {
		let cancelled = false;
		async function bootstrap() {
			const storedToken = window.localStorage.getItem(STORAGE_KEY);
			if (!storedToken) {
				setBooting(false);
				return;
			}
			try {
				const nextSession = await api.getSession(storedToken);
				if (!cancelled) {
					applySession(nextSession);
				}
			} catch {
				window.localStorage.removeItem(STORAGE_KEY);
			} finally {
				if (!cancelled) {
					setBooting(false);
				}
			}
		}
		void bootstrap();
		return () => {
			cancelled = true;
		};
	}, [applySession]);

	useEffect(() => {
		if (!isProfileMenuOpen) {
			return;
		}
		const close = (event: PointerEvent) => {
			if (
				event.target instanceof Node &&
				profileMenuRef.current?.contains(event.target)
			) {
				return;
			}
			setIsProfileMenuOpen(false);
		};
		document.addEventListener("pointerdown", close);
		return () => document.removeEventListener("pointerdown", close);
	}, [isProfileMenuOpen]);

	useEffect(() => {
		if (!session || (!error && !message)) {
			return;
		}
		const timeoutId = window.setTimeout(() => {
			setError(null);
			setMessage(null);
		}, 30000);
		return () => window.clearTimeout(timeoutId);
	}, [session, error, message, setError, setMessage]);

	useEffect(() => {
		setIsMobileChromeHidden(false);
		mobileChromeHiddenRef.current = false;
	}, [tab]);

	useEffect(() => {
		const content = appContentRef.current;
		if (!session) {
			return;
		}

		const mediaQuery = window.matchMedia("(max-width: 767px)");
		const readScrollTop = () =>
			content?.scrollTop ||
			window.scrollY ||
			document.documentElement.scrollTop ||
			0;
		let lastScrollTop = readScrollTop();
		let frameId = 0;

		const setChromeHidden = (next: boolean) => {
			if (mobileChromeHiddenRef.current === next) {
				return;
			}
			mobileChromeHiddenRef.current = next;
			setIsMobileChromeHidden(next);
		};

		const handleScrollFrame = () => {
			frameId = 0;
			if (!mediaQuery.matches) {
				lastScrollTop = readScrollTop();
				setChromeHidden(false);
				return;
			}

			const nextScrollTop = readScrollTop();
			const delta = nextScrollTop - lastScrollTop;
			// Upward gestures keep the workspace expanded until it reaches the top.
			if (nextScrollTop <= 0) {
				setChromeHidden(false);
			} else if (delta > 8) {
				setChromeHidden(true);
			}
			lastScrollTop = nextScrollTop;
		};

		const handleScroll = () => {
			if (frameId) {
				return;
			}
			frameId = window.requestAnimationFrame(handleScrollFrame);
		};

		const handleMediaChange = () => {
			if (!mediaQuery.matches) {
				setChromeHidden(false);
			}
		};

		content?.addEventListener("scroll", handleScroll, { passive: true });
		window.addEventListener("scroll", handleScroll, { passive: true });
		mediaQuery.addEventListener("change", handleMediaChange);
		return () => {
			content?.removeEventListener("scroll", handleScroll);
			window.removeEventListener("scroll", handleScroll);
			mediaQuery.removeEventListener("change", handleMediaChange);
			if (frameId) {
				window.cancelAnimationFrame(frameId);
			}
		};
	}, [session, tab]);

	const closeSidebarIfMobile = () => {
		if (window.innerWidth < 768) {
			setIsSidebarOpen(false);
		}
	};

	async function signInWithCloudflare() {
		setBusy("auth");
		setError(null);
		try {
			applySession(await api.cloudflareSession());
			setMessage(null);
		} catch (nextError) {
			setError(
				nextError instanceof Error
					? nextError.message
					: "Cloudflare session failed.",
			);
		} finally {
			setBusy(null);
		}
	}

	async function signOut() {
		setIsProfileMenuOpen(false);
		setIsUserSheetOpen(false);
		if (token) {
			await api.logout(token).catch(() => null);
		}
		queryClient.clear();
		clearSession();
		navigateToTab("overview");
	}

	/* Shared profile-menu items, used by the desktop dropdown and the mobile sheet.
     `close` dismisses whichever container invoked it. */
	const renderProfileMenu = (close: () => void) => (
		<>
			<div className="mb-2 flex items-center gap-2 px-3 py-2 text-[0.68rem] font-semibold uppercase tracking-[0.18em] text-ledger-mist/72">
				<Sparkles className="h-3.5 w-3.5 text-ledger-gold" />
				{session?.membership.role}
			</div>
			{NAV_ITEMS.filter(
				(item) => item.key === "imports" || item.key === "settings",
			).map((item) => {
				const Icon = item.icon;
				return (
					<button
						key={item.key}
						onClick={() => {
							navigateToTab(item.key);
							close();
						}}
						className="flex w-full items-center gap-2 rounded-lg px-3 py-3 text-left text-sm text-ledger-mist transition hover:bg-ledger-surface-low hover:text-ledger-ink"
						type="button"
					>
						<Icon className="h-4 w-4" />
						{item.label}
					</button>
				);
			})}
			<button
				onClick={() => {
					setIsMoneyMapOpen(true);
					close();
				}}
				className="flex w-full items-center gap-2 rounded-lg px-3 py-3 text-left text-sm text-ledger-mist transition hover:bg-ledger-surface-low hover:text-ledger-ink"
				type="button"
			>
				<Map className="h-4 w-4" />
				Money map
			</button>
			<button
				onClick={() => {
					setIsBackupsOpen(true);
					close();
				}}
				className="flex w-full items-center gap-2 rounded-lg px-3 py-3 text-left text-sm text-ledger-mist transition hover:bg-ledger-surface-low hover:text-ledger-ink"
				type="button"
			>
				<Archive className="h-4 w-4" />
				Backups
			</button>
			<button
				onClick={() => {
					close();
					void signOut();
				}}
				className="block w-full rounded-lg px-3 py-3 text-left text-sm text-ledger-mist transition hover:bg-ledger-surface-low hover:text-ledger-ink"
				type="button"
			>
				Sign out
			</button>
		</>
	);

	if (booting) {
		return (
			<div className="shell--centered auth-screen">
				<AuthWaveBackground />
				<div className="auth-card auth-card--signin">
					<div className="auth-header">
						<img className="auth-logo" src="/favicon.svg" alt="" aria-hidden="true" />
						<div>
							<span>Checkbook</span>
							<h2>Loading</h2>
						</div>
					</div>
				</div>
			</div>
		);
	}

	if (!session) {
		return (
			<div className="shell--centered auth-screen">
				<AuthWaveBackground />
				<div className="auth-card auth-card--signin">
					<div className="auth-header">
						<img className="auth-logo" src="/favicon.svg" alt="" aria-hidden="true" />
						<div>
							<span>Checkbook</span>
							<h2>Sign in</h2>
						</div>
					</div>
					{error ? <p className="feedback feedback--error">{error}</p> : null}
					<div className="auth-actions">
						<button
							className="button auth-google"
							disabled={busy === "auth"}
							onClick={() => void signInWithCloudflare()}
							type="button"
						>
							<GoogleGlyph />
							{busy === "auth" ? "Signing in..." : "Sign in with Google"}
						</button>
						{DEV_AUTH_ENABLED ? <DevelopmentLogin /> : null}
					</div>
				</div>
			</div>
		);
	}

	const ActivePage =
		tab === "overview" ? (
			<OverviewPage
				dateRange={dateRange}
				showForecast={showForecast}
				onNavigateToProjects={(id) => navigateToTab("assets", id)}
			/>
		) : tab === "planning" ? (
			isPaydayPlannerAnalysisPath(location.pathname) ? <PaydayPlannerAnalysisPage /> : <PaydayPlannerPage />
		) : tab === "income" ? (
			<IncomePage />
		) : tab === "expenses" ? (
			<ExpensesPage dateRange={expensesDateRange} showForecast={showExpensesForecast} showRetired={showRetiredExpenses} />
		) : tab === "assets" ? (
			<AssetsPage initialPropertyId={propertyFilter} />
		) : tab === "imports" ? (
			<ImportsPage />
		) : (
			<SettingsPage />
		);

	return (
		<div
			className={`app-shell ${isMobileChromeHidden ? "app-shell--mobile-chrome-hidden" : ""} ${isSidebarOpen ? "app-shell--sidebar-open" : ""}`}
		>
			<header
				className={`app-topbar ${isMobileChromeHidden ? "app-topbar--hidden" : ""}`}
			>
				{headerControls ?? (
					<div
						aria-live="polite"
						className="app-topbar-title"
						title={rangeLabel(activeRange, activeForecast)}
					>
						{dateRangeOptionLabel(activeRange)}{activeForecast ? " + Forecast" : ""}
					</div>
				)}

				<div className="app-topbar-actions">
					{headerActions}
					{tab === "overview" || tab === "expenses" ? (
						<DateRangeFilter
							forecastFilter={{ checked: activeForecast, onChange: tab === "expenses" ? setShowExpensesForecast : setShowForecast }}
							retiredFilter={tab === "expenses" ? { checked: showRetiredExpenses, onChange: setShowRetiredExpenses } : undefined}
							value={activeRange}
							onChange={(next) =>
								(tab === "expenses"
									? setExpensesDateRange
									: setDateRange)(next)
							}
						/>
					) : null}
					<div className="app-profile-shell relative" ref={profileMenuRef}>
						<button
							onClick={() => setIsProfileMenuOpen((value) => !value)}
							className="app-topbar-profile"
							title="Profile"
							type="button"
						>
							<span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-ledger-surface-low text-ledger-gold">
								<CircleUserRound className="h-4 w-4" />
							</span>
							<span className="hidden sm:inline">{session.user.full_name}</span>
							<ChevronDown className="h-4 w-4" />
						</button>
						{isProfileMenuOpen ? (
							<div className="app-profile-menu modal-shell ghost-outline absolute right-0 top-full z-50 mt-3 w-60 overflow-hidden p-2">
								{renderProfileMenu(() => setIsProfileMenuOpen(false))}
							</div>
						) : null}
					</div>
				</div>
			</header>

			{error || message ? (
				<div className="toast-host" aria-live="polite">
					{error ? (
						<ToastBanner type="error" onClose={() => setError(null)}>
							{error}
						</ToastBanner>
					) : null}
					{message ? (
						<ToastBanner type="success" onClose={() => setMessage(null)}>
							{message}
						</ToastBanner>
					) : null}
				</div>
			) : null}

			<div
				className={`app-sidebar-backdrop ${isSidebarOpen ? "app-sidebar-backdrop-visible" : ""}`}
				onClick={() => setIsSidebarOpen(false)}
			/>

			<div className="app-body min-h-[calc(100vh-4.5rem)] flex">
				<aside
					className={`app-sidebar ${isSidebarOpen ? "app-sidebar-open" : "app-sidebar-collapsed"}`}
				>
					<nav className="flex flex-1 flex-col gap-2">
						{NAV_ITEMS.filter(
							(item) =>
								item.key !== "imports" && item.key !== "settings",
						).map((item) => {
							const Icon = item.icon;
							return (
								<button
									key={item.key}
									onClick={() => {
										navigateToTab(item.key);
										closeSidebarIfMobile();
									}}
									className={`app-sidebar-link ${isSidebarOpen ? "app-sidebar-link-open" : "app-sidebar-link-collapsed"} ${tab === item.key ? "bg-white/5 text-ledger-gold status-glow" : ""}`}
									type="button"
								>
									<Icon className="h-5 w-5 shrink-0" />
									{isSidebarOpen ? <span>{item.label}</span> : null}
								</button>
							);
						})}
					</nav>

					<button
						type="button"
						onClick={() => setIsSidebarOpen((value) => !value)}
						className={`app-sidebar-link app-sidebar-toggle ${isSidebarOpen ? "app-sidebar-link-open" : "app-sidebar-link-collapsed"}`}
					>
						{isSidebarOpen ? (
							<PanelLeftClose className="h-4 w-4 shrink-0" />
						) : (
							<Menu className="h-4 w-4 shrink-0" />
						)}
						{isSidebarOpen ? <span>Menu</span> : null}
					</button>
				</aside>

				<div
					ref={appContentRef}
					className={`app-content overflow-y-auto ${isSidebarOpen ? "app-content-sidebar-open" : "app-content-sidebar-collapsed"}`}
				>
					<main className="page-shell">
						<Suspense
							fallback={
								<div className="async-state" role="status">
									Loading workspace...
								</div>
							}
						>
							{ActivePage}
						</Suspense>
					</main>
				</div>
			</div>

			<nav
				ref={bottomNavRef}
				onClickCapture={navPreview.onClickCapture}
				className={`app-bottom-nav ${isMobileChromeHidden ? "app-bottom-nav--hidden" : ""}`}
				aria-label="Primary navigation"
			>
				{NAV_ITEMS.filter((item) => item.key !== "imports" && item.key !== "settings").map((item) => {
					const Icon = item.icon;
					return (
						<button
							key={item.key}
							className={tab === item.key ? "is-active" : ""}
							data-nav-label={item.label}
							onClick={() => navigateToTab(item.key)}
							type="button"
						>
							<Icon className="h-5 w-5" />
							<span>{item.label}</span>
						</button>
					);
				})}
				<button
					aria-expanded={isUserSheetOpen}
					aria-haspopup="menu"
					className={isUserSheetOpen ? "is-active" : ""}
					data-nav-label="User"
					onClick={() => setIsUserSheetOpen((value) => !value)}
					type="button"
				>
					<CircleUserRound className="h-5 w-5" />
					<span>User</span>
				</button>
			</nav>
			{navPreview.state ? (
				<div
					className="app-bottom-nav-preview"
					role="status"
					aria-live="polite"
					style={{ "--preview-x": `${navPreview.state.originX}px` } as CSSProperties}
				>
					{navPreview.state.label}
				</div>
			) : null}

			{isUserSheetOpen ? (
				<>
					<button
						className="app-mobile-profile-backdrop"
						aria-label="Close menu"
						onClick={() => setIsUserSheetOpen(false)}
						type="button"
					/>
					<div
						className="app-mobile-profile-menu modal-shell ghost-outline"
						role="menu"
					>
						{renderProfileMenu(() => setIsUserSheetOpen(false))}
					</div>
				</>
			) : null}

			{busy === "refresh" ? (
				<div className="fixed bottom-4 right-4 z-50 rounded-full px-4 py-2 text-xs font-semibold">
					Refreshing workspace...
				</div>
			) : null}

			{isMoneyMapOpen ? (
				<MoneyMapModal onClose={() => setIsMoneyMapOpen(false)} />
			) : null}
			{isBackupsOpen ? (
				<BackupsModal onClose={() => setIsBackupsOpen(false)} />
			) : null}
		</div>
	);
}

export default function App() {
	return (
		<SessionProvider>
			<HeaderSlotProvider>
				<AppContent />
			</HeaderSlotProvider>
		</SessionProvider>
	);
}
