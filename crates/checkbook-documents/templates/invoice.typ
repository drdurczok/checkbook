#import sys: inputs
#let d = inputs

#let accent = rgb("#1e6fd6")
#let navy = rgb("#102a4c")
#let ink = rgb("#1a2233")
#let muted = rgb("#5b6b80")
#let rule-color = rgb("#dce1ea")
#let zebra = rgb("#f6f8fc")

#set document(title: "Faktura " + d.invoice_number, author: "Checkbook")
#set page(
  paper: "a4",
  margin: (top: 16mm, right: 18mm, bottom: 20mm, left: 18mm),
  footer: context [
    #line(length: 100%, stroke: 0.5pt + rule-color)
    #v(3pt)
    #grid(
      columns: (1fr, auto),
      text(size: 7.5pt, fill: muted)[Wygenerowano przez Checkbook],
      text(size: 7.5pt, fill: muted)[Strona #counter(page).display("1 / 1", both: true)],
    )
  ],
)
#set text(font: "Noto Sans", size: 9pt, fill: ink, lang: "pl")
#set par(leading: 0.65em)

#let field(label, value) = [
  #text(size: 7pt, weight: "bold", fill: muted, upper(label))
  #v(2pt)
  #text(size: 9pt)[#value]
]

#let party(label, name, details) = [
  #text(size: 7pt, weight: "bold", fill: muted, upper(label))
  #v(3pt)
  #text(size: 11pt, weight: "bold")[#name]
  #if details != "" {
    v(2pt)
    text(size: 8.5pt, fill: muted)[#details]
  }
]

#grid(
  columns: (1fr, auto),
  align: (left, right),
  [
    #text(size: 15pt, weight: "bold")[#d.seller_name]
    #v(2pt)
    #text(size: 8.5pt, fill: muted)[#d.title]
  ],
  [
    #text(size: 25pt, weight: "bold", fill: accent)[FAKTURA]
    #v(2pt)
    #text(size: 11pt)[\# #d.invoice_number]
  ],
)
#v(8pt)
#line(length: 100%, stroke: 2pt + accent)
#v(10pt)

#grid(
  columns: (1fr, 1fr, 1fr, 1fr),
  gutter: 10pt,
  field("Data wystawienia", d.issue_date),
  field("Data sprzedaży", d.sale_date),
  field("Termin płatności", d.due_date),
  field("Status", d.status),
)

#v(16pt)
#grid(
  columns: (1fr, 1fr),
  gutter: 24pt,
  party("Sprzedawca", d.seller_name, d.seller_details),
  party(
    "Nabywca",
    d.buyer_name,
    (
      d.buyer_address,
      if d.buyer_nip != "" { "NIP " + d.buyer_nip } else { "" },
      d.buyer_details,
    ).filter(value => value != "").join("\n"),
  ),
)

#v(16pt)
#table(
  columns: (2.6fr, 0.55fr, 1.15fr, 0.65fr, 1.15fr),
  align: (left, right, right, right, right),
  inset: (x: 7pt, y: 6pt),
  stroke: (x, y) => if y == 0 { none } else { (bottom: 0.5pt + rule-color) },
  fill: (x, y) => if y == 0 { navy } else if calc.odd(y) { white } else { zebra },
  table.header(
    text(fill: white, weight: "bold")[Opis],
    text(fill: white, weight: "bold")[Ilość],
    text(fill: white, weight: "bold")[Cena jedn.],
    text(fill: white, weight: "bold")[VAT],
    text(fill: white, weight: "bold")[Netto],
  ),
  ..d.lines.map(item => (
    [#item.description #if item.unit != "" { text(size: 7.5pt, fill: muted)[\ (#item.unit)] }],
    [#item.quantity],
    [#item.unit_price],
    [#item.vat_label],
    [#item.net_amount],
  )).flatten(),
)

#if d.conversion_note != "" [
  #v(5pt)
  #text(size: 7.5pt, fill: muted)[#d.conversion_note]
]

#v(12pt)
#grid(
  columns: (1fr, 0.85fr),
  gutter: 20pt,
  [
    #if d.vat_summary.len() > 0 {
      table(
        columns: (1fr, 1fr, 1fr),
        align: (left, right, right),
        inset: (x: 0pt, y: 3pt),
        stroke: none,
        ..d.vat_summary.map(item => (
          [VAT #item.vat_label],
          [#item.net_amount],
          [#item.tax_amount],
        )).flatten(),
      )
    }
  ],
  [
    #grid(
      columns: (1fr, auto),
      row-gutter: 7pt,
      align: (right, right),
      text(fill: muted)[Razem netto],
      [#d.subtotal],
      text(fill: muted)[VAT],
      [#d.tax_amount],
      line(length: 100%, stroke: 0.8pt + rule-color),
      line(length: 100%, stroke: 0.8pt + rule-color),
      text(size: 11pt, weight: "bold")[Do zapłaty],
      text(size: 11pt, weight: "bold", fill: accent)[#d.total_amount],
    )
  ],
)

#if d.payment_terms != "" [
  #v(16pt)
  #field("Warunki płatności", d.payment_terms)
]

#if d.notes != "" [
  #v(12pt)
  #field("Uwagi", d.notes)
]
