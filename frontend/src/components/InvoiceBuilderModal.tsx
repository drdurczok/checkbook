import { Checkbox } from './ui/NativeControls'
import { useEffect, useId, useMemo, useState } from "react";
import { OutlinedInput, OutlinedNativeSelect, OutlinedTextarea } from "./ui/OutlinedField";
import { createPortal } from "react-dom";
import { Download, Plus, X } from "lucide-react";
import { Modal } from "./Modal";
import { api } from "../lib/api";
import { fmtMoney, todayInputValue } from "../lib/format";
import { useSession } from "../lib/session";
import { invoiceLineNet, invoiceTotals } from "../features/invoices/totals";
import type {
	Buyer,
	InvoiceLineItem,
	InvoiceSummary,
	InvoiceWritePayload,
} from "../types";

const INVOICE_CURRENCIES = ["PLN", "EUR", "USD", "GBP"];

const VAT_RATES: Array<{ value: string; label: string }> = [
	{ value: "23", label: "23%" },
	{ value: "8", label: "8%" },
	{ value: "5", label: "5%" },
	{ value: "0", label: "0%" },
	{ value: "zw", label: "zw." },
];

const vatLabel = (rate: string) => (rate === "zw" ? "zw." : `${rate}%`);
const money = (value: number, currency: string) =>
	fmtMoney(value || 0, currency, 2);

const docDate = (value?: string | null) => {
	if (!value) return "—";
	const date = new Date(`${value}T00:00:00`);
	return Number.isNaN(date.getTime())
		? value
		: date.toLocaleDateString(undefined, { dateStyle: "medium" });
};

export type SellerDefaults = { name: string; details: string };

type LineDraft = {
	description: string;
	quantity: string;
	unit_price: string;
	vat_rate: string;
	unit: string;
	currency: string;
};

type InvoiceDraft = {
	number: string;
	issueDate: string;
	saleDate: string;
	dueDate: string;
	currency: string;
	status: string;
	conversionEnabled: boolean;
	conversionCurrency: string;
	conversionRate: string;
	client: string;
	clientNip: string;
	clientAddress: string;
	sellerName: string;
	sellerDetails: string;
	notes: string;
	items: LineDraft[];
};

const blankLine = (): LineDraft => ({
	description: "",
	quantity: "1",
	unit_price: "0",
	vat_rate: "23",
	unit: "",
	currency: "",
});

const draftFromInvoice = (invoice: InvoiceSummary): InvoiceDraft => ({
	number: invoice.invoice_number,
	issueDate: invoice.issue_date ?? todayInputValue(),
	saleDate: invoice.sale_date ?? invoice.issue_date ?? "",
	dueDate: invoice.due_date ?? "",
	currency: invoice.currency || "PLN",
	status: invoice.status || "draft",
	conversionEnabled: Boolean(invoice.conversion_enabled),
	conversionCurrency: invoice.conversion_currency || "",
	conversionRate:
		invoice.conversion_rate && invoice.conversion_rate !== 1
			? String(invoice.conversion_rate)
			: "",
	client: invoice.buyer_name ?? "",
	clientNip: invoice.buyer_nip ?? "",
	clientAddress: invoice.buyer_address ?? "",
	sellerName: invoice.seller_name ?? "",
	sellerDetails: invoice.seller_details ?? "",
	notes: invoice.notes ?? "",
	items: (invoice.line_items?.length
		? invoice.line_items
		: [
				{
					description: "",
					quantity: 1,
					unit_price: 0,
					vat_rate: "23",
					unit: "",
					currency: "",
				},
			]
	).map((it) => ({
		description: it.description ?? "",
		quantity: String(it.quantity ?? ""),
		unit_price: String(it.unit_price ?? ""),
		vat_rate: it.vat_rate ?? "23",
		unit: it.unit ?? "",
		currency: it.currency ?? "",
	})),
});

const blankDraft = (
	currency: string,
	seller: SellerDefaults,
): InvoiceDraft => ({
	number: "",
	issueDate: todayInputValue(),
	saleDate: todayInputValue(),
	dueDate: "",
	currency,
	status: "draft",
	conversionEnabled: false,
	conversionCurrency: "",
	conversionRate: "",
	client: "",
	clientNip: "",
	clientAddress: "",
	sellerName: seller.name,
	sellerDetails: seller.details,
	notes: "",
	items: [blankLine()],
});

/* ---------------- Printable invoice document (Faktura) ---------------- */
export function InvoiceDoc({ invoice }: { invoice: InvoiceSummary }) {
	const currency = invoice.currency || "PLN";
	const items = invoice.line_items ?? [];
	const conv = {
		enabled: Boolean(invoice.conversion_enabled),
		currency: invoice.conversion_currency || "",
		rate: Number(invoice.conversion_rate) || 1,
	};
	const t = invoiceTotals(
		items.map((it) => ({
			quantity: it.quantity,
			unit_price: it.unit_price,
			vat_rate: it.vat_rate ?? "23",
			currency: it.currency,
		})),
		conv,
	);
	return (
		<div className="invoice-doc">
			<div className="invoice-doc__header">
				<div>
					<span className="invoice-doc__eyebrow">Invoice / Faktura</span>
					<h3 className="invoice-doc__number">
						{invoice.invoice_number || "FV —"}
					</h3>
				</div>
				<div className="invoice-doc__dates">
					<div>
						<span>Issue date</span>
						<strong>{docDate(invoice.issue_date)}</strong>
					</div>
					<div>
						<span>Sale date</span>
						<strong>{docDate(invoice.sale_date || invoice.issue_date)}</strong>
					</div>
					<div>
						<span>Due date</span>
						<strong>{docDate(invoice.due_date)}</strong>
					</div>
				</div>
			</div>

			<div className="invoice-doc__parties">
				<div>
					<span className="invoice-doc__label">Seller</span>
					<strong>{invoice.seller_name || "—"}</strong>
					{invoice.seller_details ? <p>{invoice.seller_details}</p> : null}
				</div>
				<div>
					<span className="invoice-doc__label">Buyer</span>
					<strong>{invoice.buyer_name || "—"}</strong>
					<p>
						{invoice.buyer_address ? (
							<>
								{invoice.buyer_address}
								<br />
							</>
						) : null}
						{invoice.buyer_nip ? `NIP ${invoice.buyer_nip}` : ""}
					</p>
				</div>
			</div>

			<table className="invoice-doc__table">
				<thead>
					<tr>
						<th>Description</th>
						<th className="is-right">Qty</th>
						<th className="is-right">Unit price</th>
						<th className="is-right">VAT</th>
						<th className="is-right">Net</th>
					</tr>
				</thead>
				<tbody>
					{items.map((it, i) => (
						<tr key={i}>
							<td>
								{it.description || "—"}
								{it.unit ? (
									<span className="invoice-doc__unit"> · {it.unit}</span>
								) : null}
							</td>
							<td className="is-right">{it.quantity}</td>
							<td className="is-right">{money(it.unit_price, it.currency || currency)}</td>
							<td className="is-right">{vatLabel(it.vat_rate ?? "23")}</td>
							<td className="is-right">
								<strong>
									{money(
										invoiceLineNet(
											{
												quantity: it.quantity,
												unit_price: it.unit_price,
												currency: it.currency,
											},
											conv,
										),
										currency,
									)}
								</strong>
							</td>
						</tr>
					))}
				</tbody>
			</table>

			{conv.enabled && conv.currency ? (
				<p className="invoice-doc__fx">
					Amounts in {conv.currency} converted at 1 {conv.currency} ={" "}
					{conv.rate.toLocaleString(undefined, { maximumFractionDigits: 4 })}{" "}
					{currency}.
				</p>
			) : null}

			<div className="invoice-doc__summary">
				<div className="invoice-doc__vat">
					<span className="invoice-doc__label">VAT summary</span>
					<table>
						<tbody>
							{Object.entries(t.byRate).map(([rate, v]) => (
								<tr key={rate}>
									<td>{vatLabel(rate)}</td>
									<td className="is-right">net {money(v.net, currency)}</td>
									<td className="is-right">VAT {money(v.vat, currency)}</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
				<div className="invoice-doc__totals">
					<div>
						<span>Net total</span>
						<span>{money(t.net, currency)}</span>
					</div>
					<div>
						<span>VAT</span>
						<span>{money(t.vat, currency)}</span>
					</div>
					<div className="invoice-doc__grand">
						<span>Total due</span>
						<span>{money(t.gross, currency)}</span>
					</div>
				</div>
			</div>

			{invoice.notes ? (
				<div className="invoice-doc__notes">
					<span className="invoice-doc__label">Notes</span>
					<p>{invoice.notes}</p>
				</div>
			) : null}
		</div>
	);
}

/* ---------------- Builder modal (edit + preview) ---------------- */
export function InvoiceBuilderModal({
	invoice,
	sourceId,
	seller,
	defaultCurrency,
	onClose,
	onSaved,
}: {
	invoice: InvoiceSummary | null;
	sourceId: string;
	seller: SellerDefaults;
	defaultCurrency: string;
	onClose: () => void;
	onSaved: (invoice: InvoiceSummary) => void;
}) {
	const fieldId = useId();
	const { token, setError } = useSession();
	const [busy, setBusy] = useState<string | null>(null);
	const [view, setView] = useState<"edit" | "preview">("edit");
	const [draft, setDraft] = useState<InvoiceDraft>(() =>
		invoice ? draftFromInvoice(invoice) : blankDraft(defaultCurrency, seller),
	);
	// Buyer picker: "" = none chosen, a buyer id = saved buyer (read-only preview),
	// "new" = add a new buyer (editable fields + save).
	const [buyers, setBuyers] = useState<Buyer[]>([]);
	const [buyerChoice, setBuyerChoice] = useState<string>(invoice ? "new" : "");

	const set = (patch: Partial<InvoiceDraft>) =>
		setDraft((current) => ({ ...current, ...patch }));

	useEffect(() => {
		if (!token) return;
		let cancelled = false;
		api
			.getBuyers(token)
			.then((list) => {
				if (cancelled) return;
				setBuyers(list);
				if (invoice) {
					const match = list.find(
						(b) =>
							b.name === invoice.buyer_name &&
							(b.nip || "") === (invoice.buyer_nip || ""),
					);
					if (match) setBuyerChoice(match.id);
				}
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, [token, invoice]);

	function chooseBuyer(value: string) {
		setBuyerChoice(value);
		if (value === "" || value === "new") {
			set({ client: "", clientNip: "", clientAddress: "" });
			return;
		}
		const buyer = buyers.find((b) => b.id === value);
		if (buyer)
			set({
				client: buyer.name,
				clientNip: buyer.nip,
				clientAddress: buyer.address,
			});
	}

	const savingBuyer = busy === "buyer-save";
	async function saveBuyer() {
		if (!token || !draft.client.trim()) return;
		setBusy("buyer-save");
		setError(null);
		try {
			const created = await api.createBuyer(token, {
				name: draft.client.trim(),
				nip: draft.clientNip.trim(),
				address: draft.clientAddress.trim(),
			});
			setBuyers((current) =>
				[...current, created].sort((a, b) => a.name.localeCompare(b.name)),
			);
			setBuyerChoice(created.id);
		} catch (nextError) {
			setError(
				nextError instanceof Error
					? nextError.message
					: "Saving the buyer failed.",
			);
		} finally {
			setBusy(null);
		}
	}
	const setItem = (index: number, patch: Partial<LineDraft>) =>
		setDraft((current) => ({
			...current,
			items: current.items.map((it, i) =>
				i === index ? { ...it, ...patch } : it,
			),
		}));
	const addItem = () =>
		setDraft((current) => ({
			...current,
			items: [...current.items, blankLine()],
		}));
	const delItem = (index: number) =>
		setDraft((current) => ({
			...current,
			items: current.items.filter((_, i) => i !== index),
		}));

	const conv = useMemo(
		() => ({
			enabled:
				draft.conversionEnabled &&
				Boolean(draft.conversionCurrency) &&
				Number(draft.conversionRate) > 0,
			currency: draft.conversionCurrency,
			rate: Number(draft.conversionRate) || 1,
		}),
		[draft.conversionEnabled, draft.conversionCurrency, draft.conversionRate],
	);
	const t = useMemo(
		() =>
				invoiceTotals(
					draft.items.map((it) => ({
						quantity: it.quantity,
						unit_price: it.unit_price,
					vat_rate: it.vat_rate,
					currency: it.currency,
				})),
				conv,
			),
		[draft.items, conv],
	);
	// Currencies a line's unit price can be quoted in (invoice + optional foreign).
	const lineCurrencies = conv.enabled
		? [draft.currency, draft.conversionCurrency].filter(
				(c, i, arr) => c && arr.indexOf(c) === i,
			)
		: [draft.currency];
	const saving = busy === "invoice-save";
	const canSave = draft.client.trim().length > 0 && Boolean(draft.issueDate);

	const buildPayload = (): InvoiceWritePayload => ({
		save_template: false,
		invoice_number: draft.number.trim() || null,
		title: "",
		income_source_id: sourceId,
		seller_name: draft.sellerName,
		seller_details: draft.sellerDetails,
		buyer_name: draft.client.trim(),
		buyer_details: "",
		buyer_nip: draft.clientNip,
		buyer_address: draft.clientAddress,
		issue_date: draft.issueDate,
		sale_date: draft.saleDate || null,
		due_date: draft.dueDate || null,
		currency: draft.currency,
		status: draft.status,
		conversion_enabled: conv.enabled,
		conversion_currency: conv.enabled ? conv.currency : "",
		conversion_rate: conv.enabled ? conv.rate : 1,
		payment_terms: "",
		notes: draft.notes,
		line_items: draft.items
			.filter((it) => it.description.trim() && Number(it.quantity) > 0)
			.map(
				(it): InvoiceLineItem => ({
					description: it.description.trim(),
					quantity: Number(it.quantity) || 0,
					unit_price: Number(it.unit_price) || 0,
					vat_rate: it.vat_rate,
					unit: it.unit.trim(),
					currency:
						conv.enabled && it.currency === conv.currency ? it.currency : "",
				}),
			),
	});

	async function persist(): Promise<InvoiceSummary | null> {
		if (!token || !canSave) return null;
		if (!buildPayload().line_items.length) {
			setError("Add at least one line item.");
			return null;
		}
		setBusy("invoice-save");
		setError(null);
		try {
			const payload = buildPayload();
			const saved = invoice
				? await api.updateInvoice(token, invoice.id, payload)
				: await api.generateInvoice(token, payload);
			return saved;
		} catch (nextError) {
			setError(
				nextError instanceof Error
					? nextError.message
					: "Saving the invoice failed.",
			);
			return null;
		} finally {
			setBusy(null);
		}
	}

	async function handleSave() {
		const saved = await persist();
		if (saved) onSaved(saved);
	}

	async function handlePrint() {
		const saved = await persist();
		if (!saved || !token) return;
		try {
			const blob = await api.downloadInvoicePdf(token, saved.id);
			const url = window.URL.createObjectURL(blob);
			const link = document.createElement("a");
			link.href = url;
			link.download = `${saved.invoice_number}.pdf`;
			document.body.appendChild(link);
			link.click();
			link.remove();
			window.URL.revokeObjectURL(url);
			onSaved(saved);
		} catch (nextError) {
			setError(
				nextError instanceof Error
					? nextError.message
					: "Invoice download failed.",
			);
		}
	}

	const previewInvoice: InvoiceSummary = {
		...(invoice ?? ({} as InvoiceSummary)),
		invoice_number: draft.number || invoice?.invoice_number || "FV —",
		income_source_id: sourceId,
		seller_name: draft.sellerName,
		seller_details: draft.sellerDetails,
		buyer_name: draft.client,
		buyer_details: "",
		buyer_nip: draft.clientNip,
		buyer_address: draft.clientAddress,
		issue_date: draft.issueDate,
		sale_date: draft.saleDate,
		due_date: draft.dueDate,
		currency: draft.currency,
		status: draft.status,
		conversion_enabled: conv.enabled,
		conversion_currency: conv.enabled ? conv.currency : "",
		conversion_rate: conv.enabled ? conv.rate : 1,
		notes: draft.notes,
		subtotal: t.net,
		tax_amount: t.vat,
		total_amount: t.gross,
		line_items: draft.items.map((it) => ({
			description: it.description,
			quantity: Number(it.quantity) || 0,
			unit_price: Number(it.unit_price) || 0,
			vat_rate: it.vat_rate,
			unit: it.unit,
			currency: conv.enabled && it.currency === conv.currency ? it.currency : "",
		})),
	};

	return createPortal(
		<Modal
			className="invoice-builder-modal"
			headerClassName="invoice-builder-modal__header"
			eyebrow={invoice ? "Edit invoice" : "New invoice"}
			title={draft.number || (invoice ? invoice.invoice_number : "New invoice")}
			titleId="invoice-builder-title"
			onClose={onClose}
			actions={
				<div className="invoice-builder-modal__actions">
					<div
						className="segmented-control invoice-builder-toggle"
						role="tablist"
					>
						<button
							className={view === "edit" ? "is-active" : ""}
							onClick={() => setView("edit")}
							type="button"
						>
							Edit
						</button>
						<button
							className={view === "preview" ? "is-active" : ""}
							onClick={() => setView("preview")}
							type="button"
						>
							Preview
						</button>
					</div>
					<button
						aria-label="Close"
						className="record-add-close"
						onClick={onClose}
						type="button"
					>
						<X className="h-4 w-4" />
					</button>
				</div>
			}
			footer={
				<footer className="invoice-builder-footer">
					<span className="invoice-builder-footer__total">
						{money(t.gross, draft.currency)} <small>total</small>
					</span>
					<div className="invoice-builder-footer__actions">
						<button
							className="button button--compact button--ghost"
							disabled={saving || !canSave}
							onClick={() => void handlePrint()}
							type="button"
						>
							<Download className="h-4 w-4" /> Print / PDF
						</button>
						<button
							className="button button--compact button--ghost"
							onClick={onClose}
							type="button"
						>
							Cancel
						</button>
						<button
							className="button button--compact"
							disabled={saving || !canSave}
							onClick={() => void handleSave()}
							type="button"
						>
							{saving ? "Saving..." : "Save invoice"}
						</button>
					</div>
				</footer>
			}
		>
			<div
				className={`invoice-builder-body${view === "preview" ? " invoice-builder-body--preview" : ""}`}
			>
				{view === "preview" ? (
					<InvoiceDoc invoice={previewInvoice} />
				) : (
					<div className="invoice-builder-form">
						<div className="invoice-builder-meta">
							<OutlinedInput
								id={`${fieldId}-draft-number`}
								label="Invoice number"
								placeholder="Auto"
								value={draft.number}
								onChange={(e) => set({ number: e.target.value })}
							/>
							<OutlinedInput
								id={`${fieldId}-draft-issueDate`}
								label="Issue date"
								type="date"
								value={draft.issueDate}
								onChange={(e) => set({ issueDate: e.target.value })}
							/>
							<OutlinedInput
								id={`${fieldId}-draft-saleDate`}
								label="Sale date"
								type="date"
								value={draft.saleDate}
								onChange={(e) => set({ saleDate: e.target.value })}
							/>
							<OutlinedInput
								id={`${fieldId}-draft-dueDate`}
								label="Due date"
								type="date"
								value={draft.dueDate}
								onChange={(e) => set({ dueDate: e.target.value })}
							/>
						</div>

						<div className="invoice-builder-currency-row">
							<OutlinedNativeSelect
								id={`${fieldId}-draft-currency`}
								label="Currency"
								value={draft.currency}
								onChange={(e) => set({ currency: e.target.value })}
							>
								{INVOICE_CURRENCIES.map((c) => (
									<option key={c} value={c}>
										{c}
									</option>
								))}
							</OutlinedNativeSelect>
							<OutlinedNativeSelect
								id={`${fieldId}-draft-status`}
								label="Status"
								value={draft.status}
								onChange={(e) => set({ status: e.target.value })}
							>
								<option value="draft">Draft</option>
								<option value="sent">Sent</option>
								<option value="paid">Paid</option>
								<option value="overdue">Overdue</option>
							</OutlinedNativeSelect>
							<label className="invoice-conversion-toggle">
								<Checkbox

									checked={draft.conversionEnabled}
									onChange={(e) =>
										set({ conversionEnabled: e.target.checked })
									}
								/>
								<span>Currency conversion</span>
							</label>
							{draft.conversionEnabled ? (
								<>
									<OutlinedNativeSelect
										id={`${fieldId}-draft-conversionCurrency`}
										label="Convert from"
										value={draft.conversionCurrency}
										onChange={(e) =>
											set({ conversionCurrency: e.target.value })
										}
									>
										<option value="">Select…</option>
										{INVOICE_CURRENCIES.filter(
											(c) => c !== draft.currency,
										).map((c) => (
											<option key={c} value={c}>
												{c}
											</option>
										))}
									</OutlinedNativeSelect>
									<OutlinedInput
										id={`${fieldId}-draft-conversionRate`}
										label={`Rate (1 ${draft.conversionCurrency || "?"} = ${draft.currency})`}
										type="number"
										step="0.0001"
										placeholder="0.0000"
										value={draft.conversionRate}
										onChange={(e) =>
											set({ conversionRate: e.target.value })
										}
									/>
								</>
							) : null}
						</div>

						<section className="invoice-builder-section">
							<div className="invoice-builder-section__head">
								<span>Buyer</span>
							</div>
							<OutlinedNativeSelect
								id={`${fieldId}-buyerChoice`}
								label="Select buyer"
								value={buyerChoice}
								onChange={(e) => chooseBuyer(e.target.value)}
							>
								<option value="">Select a buyer…</option>
								{buyers.map((b) => (
									<option key={b.id} value={b.id}>
										{b.name}
									</option>
								))}
								<option value="new">+ New buyer</option>
							</OutlinedNativeSelect>
							{buyerChoice === "new" ? (
								<div className="invoice-buyer-card invoice-buyer-card--edit">
									<div className="invoice-builder-buyer">
										<OutlinedInput
											id={`${fieldId}-draft-client`}
											label="Client name"
											className="invoice-builder-buyer__name"
											value={draft.client}
											onChange={(e) => set({ client: e.target.value })}
										/>
										<OutlinedInput
											id={`${fieldId}-draft-clientAddress`}
											label="Address"
											value={draft.clientAddress}
											onChange={(e) => set({ clientAddress: e.target.value })}
										/>
										<OutlinedInput
											id={`${fieldId}-draft-clientNip`}
											label="NIP / Tax ID"
											value={draft.clientNip}
											onChange={(e) => set({ clientNip: e.target.value })}
										/>
									</div>
									<button
										className="button button--compact"
										disabled={savingBuyer || !draft.client.trim()}
										onClick={() => void saveBuyer()}
										type="button"
									>
										{savingBuyer ? "Saving…" : "Save buyer"}
									</button>
								</div>
							) : buyerChoice ? (
								<div className="invoice-buyer-card">
									<strong>{draft.client || "—"}</strong>
									<p>
										{draft.clientAddress ? (
											<>
												{draft.clientAddress}
												<br />
											</>
										) : null}
										{draft.clientNip ? `NIP ${draft.clientNip}` : null}
									</p>
								</div>
							) : null}
						</section>

						<section className="invoice-builder-section">
							<div className="invoice-builder-section__head">
								<span>Line items</span>
								<small>Net auto-totals per line</small>
							</div>
							<div
								className={`invoice-line invoice-line--head${conv.enabled ? " invoice-line--fx" : ""}`}
							>
								<span>Description</span>
								<span className="is-right">Qty</span>
								<span className="is-right">Unit price</span>
								{conv.enabled ? <span className="is-right">Cur.</span> : null}
								<span className="is-right">VAT</span>
								<span className="is-right">Net</span>
								<span />
							</div>
							<div className="invoice-line-list">
								{draft.items.map((it, i) => {
									const lineNet = invoiceLineNet(
										{
											quantity: it.quantity,
											unit_price: it.unit_price,
											currency: it.currency,
										},
										conv,
									);
									return (
										<div
											className={`invoice-line${conv.enabled ? " invoice-line--fx" : ""}`}
											key={i}
										>
											<OutlinedInput
												id={`${fieldId}-it-description-${i}`}
												label="Description"
												placeholder="Service or product"
												value={it.description}
												onChange={(e) =>
													setItem(i, { description: e.target.value })
												}
											/>
											<OutlinedInput
												id={`${fieldId}-it-quantity-${i}`}
												label="Qty"
												className="is-right"
												type="number"
												value={it.quantity}
												onChange={(e) =>
													setItem(i, { quantity: e.target.value })
												}
											/>
											<OutlinedInput
												id={`${fieldId}-it-unit_price-${i}`}
												label="Unit price"
												className="is-right"
												type="number"
												value={it.unit_price}
												onChange={(e) =>
													setItem(i, { unit_price: e.target.value })
												}
											/>
											{conv.enabled ? (
												<OutlinedNativeSelect
													id={`${fieldId}-it-currency-${i}`}
													label="Currency"
													className="is-right"
													value={it.currency || draft.currency}
													onChange={(e) =>
														setItem(i, {
															currency:
																e.target.value === draft.currency
																	? ""
																	: e.target.value,
														})
													}
												>
													{lineCurrencies.map((c) => (
														<option key={c} value={c}>
															{c}
														</option>
													))}
												</OutlinedNativeSelect>
											) : null}
											<OutlinedNativeSelect
												id={`${fieldId}-it-vat_rate-${i}`}
												label="VAT"
												className="is-right"
												value={it.vat_rate}
												onChange={(e) =>
													setItem(i, { vat_rate: e.target.value })
												}
											>
												{VAT_RATES.map((r) => (
													<option key={r.value} value={r.value}>
														{r.label}
													</option>
												))}
											</OutlinedNativeSelect>
											<span className="invoice-line__net">
												{money(lineNet, draft.currency)}
											</span>
											<button
												className="invoice-line__remove"
												aria-label="Remove line"
												disabled={draft.items.length === 1}
												onClick={() => delItem(i)}
												type="button"
											>
												<X className="h-4 w-4" />
											</button>
										</div>
									);
								})}
							</div>
							<button
								className="button button--compact button--ghost"
								onClick={addItem}
								type="button"
							>
								<Plus className="h-3.5 w-3.5" /> Add line item
							</button>
						</section>

						<div className="invoice-builder-tail">
							<OutlinedTextarea
								id={`${fieldId}-draft-notes`}
								label="Notes / payment terms"
								className="invoice-builder-notes"
								value={draft.notes}
								placeholder="e.g. Payment within 14 days. Thank you."
								onChange={(e) => set({ notes: e.target.value })}
							/>
							<div className="invoice-totals-card">
								<div>
									<span>Net</span>
									<span>{money(t.net, draft.currency)}</span>
								</div>
								<div>
									<span>VAT</span>
									<span>{money(t.vat, draft.currency)}</span>
								</div>
								<div className="invoice-totals-card__grand">
									<span>Total due</span>
									<span>{money(t.gross, draft.currency)}</span>
								</div>
							</div>
						</div>
					</div>
				)}
			</div>
		</Modal>,
		document.body,
	);
}
