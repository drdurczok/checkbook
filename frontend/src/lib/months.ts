export function nextAvailableMonth(periods: string[], now = new Date(), timeZone?: string): string {
  const latest = [...periods].sort().at(-1)
  if (!latest) {
    const parts = new Intl.DateTimeFormat('en-US', { year: 'numeric', month: '2-digit', timeZone }).formatToParts(now)
    return `${parts.find((part) => part.type === 'year')?.value}-${parts.find((part) => part.type === 'month')?.value}`
  }
  const [year, month] = latest.split('-').map(Number)
  return `${year + (month === 12 ? 1 : 0)}-${String(month === 12 ? 1 : month + 1).padStart(2, '0')}`
}
